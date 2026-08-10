import type { Database, Statement } from 'db0'
import type {
  MonitorEvent,
  MonitorFacetCounts,
  MonitorFacetFilter,
  MonitorHealth,
  MonitorIgnoreOptions,
  MonitorIssue,
  MonitorOverview,
  MonitorRelease,
  MonitorRouteStat,
  MonitorSessionStats,
} from '../../types'
import type { CompiledIgnore } from '../shared/ignore'
import { compileIgnore, shouldIgnore } from '../shared/ignore'
import { fingerprint } from '../shared/fingerprint'
import { bucketOf, normalizeRoute, statusClass } from '../shared/route'
import { culpritOf } from './rows'
import * as queries from './queries'
import { BUCKET_MS, migrate } from './schema'
import { changesOf, openDatabase, upsertClause } from './db'
import type { MonitorDatabase } from './db'

export interface StoreOptions {
  /** Directory holding `monitor.db`. Created if missing. */
  dir: string
  /** Connection string for an external database. SQLite in `dir` when unset. */
  url?: string
  retentionDays: number
  maxEventsPerIssue: number
  /** Ceiling on distinct issues. Oldest and rarest evicted first. */
  maxIssues?: number
  /** Ceiling on stored bytes. `0` disables it. */
  maxBytes?: number
  /** Rules for what never reaches the database. */
  ignore?: MonitorIgnoreOptions
  /** Events buffered before an early flush. */
  flushSize?: number
  /** Milliseconds between periodic flushes. */
  flushInterval?: number
  /** Milliseconds between retention sweeps. Default: 6 hours. */
  purgeInterval?: number
}

/**
 * Joins the parts of a counter key. A route may legitimately contain a space
 * or a colon, so the separator has to be something a URL cannot hold.
 */
const KEY_SEPARATOR = '\u0000'

/**
 * Ceilings on what a failing write may hold in memory.
 *
 * Failed batches are retried rather than dropped, which is right for a
 * transient lock and wrong forever: against a database that stays unwritable,
 * retrying without a bound turns a full disk into an out-of-memory kill in the
 * application being monitored. Past these the oldest are dropped and the loss
 * is logged — a monitoring tool may lose data, but it may not take the process
 * down with it.
 */
const MAX_PENDING_EVENTS = 1_000
const MAX_PENDING_COUNTERS = 10_000

/**
 * How long the request path stops flushing after a failed write.
 *
 * Long enough that a lock contended by the dashboard clears on its own, short
 * enough that a recovered database starts persisting again within one buffer.
 */
const RETRY_BACKOFF_MS = 5_000

/** Minimum gap between "events were dropped" lines. */
const DROP_REPORT_INTERVAL_MS = 60_000

/**
 * Events deleted per pass when over the byte ceiling.
 *
 * How many bytes a row frees is not knowable in advance — one event carries a
 * 20 KB stack, the next almost nothing — so eviction deletes a chunk and
 * measures again rather than computing a count up front.
 */
const EVICTION_CHUNK = 500

/** Passes per sweep. Enough to shrink a badly overshot database, not a stall. */
const MAX_EVICTION_PASSES = 20

/**
 * Events kept whatever the ceiling says.
 *
 * A limit set below what the traffic produces would otherwise empty the
 * database on every sweep, and an empty dashboard reads as "no errors" rather
 * than "the limit is too low" — the most misleading state this can be in.
 */
const MIN_KEPT_EVENTS = 200

/**
 * Buffered, append-oriented store for captured errors.
 *
 * Writes are batched deliberately. `node:sqlite` is synchronous, so inserting
 * on the request path would put an fsync between the error and the response —
 * an error storm would then slow the very app it is reporting on. Events land
 * in memory and are flushed together inside one transaction.
 */
export class MonitorStore {
  private db: Database
  private connection: MonitorDatabase
  private buffer: (MonitorEvent & { fingerprint: string })[] = []
  /** `bucket route method class` → count, aggregated between flushes. */
  private counters = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private purgeTimer: ReturnType<typeof setInterval> | undefined
  private readonly flushSize: number
  private readonly maxIssues: number
  private readonly maxBytes: number
  private readonly ignore: CompiledIgnore
  private closed = false
  /** Timestamp before which size-triggered flushes are skipped. */
  private retryAfter = 0
  /** Events discarded because they could not be written. Surfaced in health. */
  private dropped = 0
  private nextDropReport = 0
  /** True while the byte ceiling cannot be met. Surfaced in health. */
  private overCeiling = false
  /** The flush in flight, so a second caller queues behind it rather than racing. */
  private flushing: Promise<void> | undefined
  private nextCeilingReport = 0
  /** Reused prepared statements, keyed by role. */
  private statements = new Map<string, Statement>()

  /**
   * Opens a store, ready to use.
   *
   * A factory rather than a constructor because opening and migrating are
   * asynchronous now, and a half-migrated store handed out by a constructor
   * that could not await would fail on its first write instead of here, where
   * the caller is already prepared to turn collection off.
   */
  static async open(options: StoreOptions): Promise<MonitorStore> {
    const connection = openDatabase({ dir: options.dir, url: options.url })
    const store = new MonitorStore(options, connection)

    await store.prepareDatabase()

    return store
  }

  private constructor(private options: StoreOptions, connection: MonitorDatabase) {
    this.connection = connection
    this.db = connection.db

    this.flushSize = options.flushSize ?? 100
    this.maxIssues = options.maxIssues ?? 5_000
    this.maxBytes = options.maxBytes ?? 0
    this.ignore = compileIgnore(options.ignore)
  }

  /** Schema, pragmas and the background timers. */
  private async prepareDatabase(): Promise<void> {
    if (this.connection.dialect === 'sqlite') {
      // Before any table exists, and before WAL: SQLite only accepts a change
      // to `auto_vacuum` on an empty database, and silently keeps the old mode
      // otherwise. Without it, deleting rows returns pages to a freelist that
      // the file never gives back to the disk — so a database that once spiked
      // to 500 MB stays 500 MB on disk forever, which is precisely what a size
      // ceiling exists to prevent. Existing databases keep their mode; there
      // the ceiling still bounds what is stored, not what the file occupies.
      await this.db.exec('PRAGMA auto_vacuum = INCREMENTAL')

      // WAL lets the dashboard read while collection keeps writing. NORMAL
      // trades a durability window on power loss for far fewer fsyncs, which
      // is the right side of that trade for error telemetry.
      await this.db.exec('PRAGMA journal_mode = WAL')
      await this.db.exec('PRAGMA synchronous = NORMAL')
    }

    await migrate(this.db, this.connection.dialect)

    const interval = this.options.flushInterval ?? 1_000
    this.timer = setInterval(() => void this.flush(), interval)
    // Must not hold the process open — a CLI build should still exit.
    this.timer.unref?.()

    await this.startPurging(this.options.purgeInterval ?? 6 * 60 * 60 * 1_000)
  }

  /**
   * Applies retention, now and periodically.
   *
   * Without this `retentionDays` is a setting that reads well and does
   * nothing: `purge` used to have no caller outside the tests, so a database
   * grew for as long as the process ran and every documented guarantee about
   * how long data is kept was false.
   *
   * Once at startup, because a long-lived process is not the only shape — a
   * server restarted daily would otherwise never reach the first interval.
   */
  private async startPurging(interval: number): Promise<void> {
    await this.safePurge()

    this.purgeTimer = setInterval(() => void this.safePurge(), interval)
    this.purgeTimer.unref?.()
  }

  /** Retention must never take the application down with it. */
  private async safePurge(): Promise<void> {
    if (this.closed) {
      return
    }

    try {
      await this.purge()
    }
    catch (error) {
      console.error('[monitor] failed to apply retention', error)
    }
  }

  /**
   * A prepared statement, prepared once.
   *
   * These four run on the write path — `flush` fires every second and again on
   * every dashboard read — so re-preparing them each time meant parsing the
   * same SQL several times per request for no benefit. Prepared statements are
   * reusable; the cache is keyed by role rather than by SQL text so a typo
   * cannot silently create a second entry.
   */
  /**
   * Wraps a `LIMIT`ed subquery so MySQL will accept it.
   *
   * MySQL refuses `IN (SELECT ... LIMIT ...)` outright — "this version does
   * not yet support LIMIT & IN/ALL/ANY/SOME subquery" — but allows the same
   * query one level down, as a derived table. The others take it either way,
   * so the wrapper is applied only where it is needed.
   */
  private derived(sql: string): string {
    return this.connection.dialect === 'mysql' ? `SELECT * FROM (${sql}) AS _limited` : sql
  }

  private statement(key: string, sql: string): Statement {
    let prepared = this.statements.get(key)

    if (!prepared) {
      prepared = this.db.prepare(sql)
      this.statements.set(key, prepared)
    }

    return prepared
  }

  /** Buffers an event. Returns the fingerprint it was grouped under. */
  capture(event: MonitorEvent): string {
    if (this.closed) {
      return ''
    }

    // Filtered here rather than in each collector, so one set of rules covers
    // both the server hook and the browser intake.
    if (shouldIgnore(event, this.ignore)) {
      return ''
    }

    const fp = fingerprint(event)
    this.buffer.push({ ...event, fingerprint: fp })

    // Size-triggered flushes are suppressed while writes are failing. A failed
    // batch stays in the buffer, so the buffer is still over the threshold on
    // the very next event — without this, every subsequent request would drag
    // another doomed transaction onto its own hot path. The interval timer
    // keeps retrying in the background instead.
    //
    // Deliberately not awaited, and `capture` stays synchronous: it is called
    // from Nitro's error hook and from the ingest handler, and making the
    // response wait on a database write is exactly the cost this buffering
    // exists to avoid.
    if (this.buffer.length >= this.flushSize && !this.writesFailing()) {
      void this.flush()
    }

    return fp
  }

  /** True while the last write failed and the backoff has not yet elapsed. */
  private writesFailing(now = Date.now()): boolean {
    return now < this.retryAfter
  }

  /**
   * Counts a finished request.
   *
   * Aggregated in memory and flushed with everything else: an increment per
   * request would put a write on the hot path of *every* request, not just
   * failing ones, which is the opposite of what a monitoring tool should cost.
   */
  countRequest(route: string, method: string, status: number, at = Date.now()): void {
    if (this.closed) {
      return
    }

    const key = [
      bucketOf(at, BUCKET_MS),
      normalizeRoute(route),
      method.toUpperCase().slice(0, 10),
      statusClass(status),
    ].join(KEY_SEPARATOR)

    this.counters.set(key, (this.counters.get(key) ?? 0) + 1)

    // A bound on distinct routes seen between flushes, in case normalisation
    // meets something it cannot collapse. Not awaited, for the same reason as
    // in `capture` — this runs on every request.
    if (this.counters.size > 5_000) {
      void this.flushCounters()
    }
  }

  /** Writes buffered counters. */
  private async flushCounters(): Promise<void> {
    if (this.counters.size === 0) {
      return
    }

    const batch = this.counters
    this.counters = new Map()

    const upsert = this.statement('counters', `
      INSERT INTO request_stats (bucket, route, method, class, count)
      VALUES (?, ?, ?, ?, ?)
      ${upsertClause(this.connection.dialect, 'request_stats', ['bucket', 'route', 'method', 'class'], ['count = count + excluded.count'])}
    `)

    await this.db.exec('BEGIN')

    try {
      for (const [key, count] of batch) {
        const [bucket, route, method, statusGroup] = key.split(KEY_SEPARATOR)

        await upsert.run(Number(bucket), route!, method!, statusGroup!, count)
      }

      await this.db.exec('COMMIT')
    }
    catch (error) {
      await this.rollback()
      console.error('[monitor] failed to flush request counters', error)

      // Merged back rather than dropped: a rolled-back transaction wrote
      // nothing, so discarding the batch would silently lose the counts that
      // every error rate is divided by. Counts that arrived while the write
      // was in flight win, since they are already in the new map.
      for (const [key, count] of batch) {
        this.counters.set(key, (this.counters.get(key) ?? 0) + count)
      }

      this.dropCountersIfHopeless()
    }
  }

  /**
   * A rollback on an already-broken connection throws again, and that throw
   * would escape a `catch` block whose whole job is to contain the first one.
   */
  private async rollback(): Promise<void> {
    try {
      await this.db.exec('ROLLBACK')
    }
    catch {
      // Nothing to undo if the transaction never opened.
    }
  }

  /**
   * Retrying forever is its own failure mode.
   *
   * If the database stays unwritable, re-queueing on every flush turns a bad
   * disk into unbounded memory growth. Past this many pending counters the
   * oldest are dropped: losing counts is bad, exhausting the application's
   * heap to preserve them is worse.
   */
  private dropCountersIfHopeless(): void {
    if (this.counters.size <= MAX_PENDING_COUNTERS) {
      return
    }

    const excess = this.counters.size - MAX_PENDING_COUNTERS

    for (const key of [...this.counters.keys()].slice(0, excess)) {
      this.counters.delete(key)
    }

    this.dropped += excess
    this.reportDrops()
  }

  /**
   * Writes buffered events. Safe to call when the buffer is empty.
   *
   * Serialised against itself. Writing used to be synchronous, so a flush ran
   * to completion before anything else could start one; now the timer, the
   * size trigger and `close` can all arrive while one is mid-transaction, and
   * two overlapping `BEGIN`s on one connection do not nest — the second
   * commits the first's work and the pairing comes apart. Callers that fire
   * and forget therefore join the in-flight flush rather than starting a
   * second.
   */
  flush(): Promise<void> {
    this.flushing = this.flushing
      ? this.flushing.then(() => this.runFlush())
      : this.runFlush()

    return this.flushing
  }

  private async runFlush(): Promise<void> {
    await this.flushCounters()

    if (this.closed || this.buffer.length === 0) {
      return
    }

    const batch = this.buffer
    this.buffer = []

    // `culprit`/`route`/`method`/`status` keep the freshest location: a moved
    // line is more useful than the one recorded when the issue first appeared.
    // `resolved = 0` reopens an issue that happens again.
    const upsertIssue = this.statement('issue', `
      INSERT INTO issues (
        fingerprint, type, message, side, count, first_seen, last_seen,
        culprit, route, method, status
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ${upsertClause(this.connection.dialect, 'issues', ['fingerprint'], [
        'count = count + 1',
        'last_seen = excluded.last_seen',
        'culprit = COALESCE(excluded.culprit, culprit)',
        'route = COALESCE(excluded.route, route)',
        'method = COALESCE(excluded.method, method)',
        'status = COALESCE(excluded.status, status)',
        'resolved = 0',
      ])}
    `)

    const insertEvent = this.statement('event', `
      INSERT INTO events (
        fingerprint, ts, stack, context, breadcrumbs, tags, message,
        session, browser, browser_version, os, os_version, device_type, \`release\`, route
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    await this.db.exec('BEGIN')

    try {
      for (const event of batch) {
        const context = event.context ?? {}

        await upsertIssue.run(
          event.fingerprint,
          event.type,
          event.message.slice(0, 1_000),
          event.side,
          event.timestamp,
          event.timestamp,
          culpritOf(event.stack) ?? null,
          typeof context.url === 'string' ? context.url.slice(0, 300) : null,
          typeof context.method === 'string' ? context.method : null,
          typeof context.statusCode === 'number' ? context.statusCode : null,
        )

        const facets = event.facets ?? {}

        await insertEvent.run(
          event.fingerprint,
          event.timestamp,
          event.stack ?? null,
          event.context ? JSON.stringify(event.context) : null,
          event.breadcrumbs ? JSON.stringify(event.breadcrumbs) : null,
          event.tags ? JSON.stringify(event.tags) : null,
          event.message.slice(0, 1_000),
          facets.session ?? null,
          facets.browser ?? null,
          facets.browserVersion ?? null,
          facets.os ?? null,
          facets.osVersion ?? null,
          facets.deviceType ?? null,
          facets.release ?? null,
          // The route shape, not the raw path: a breakdown over `/users/1`,
          // `/users/2`, … would have one row per visitor.
          normalizeRoute(typeof context.url === 'string' ? context.url : undefined),
        )
      }

      await this.db.exec('COMMIT')
    }
    catch (error) {
      await this.rollback()
      // Never rethrow: this runs detached from the request, and a failed
      // write must not become a second error to report.
      console.error('[monitor] failed to flush events', error)

      // The rollback wrote nothing, so these events still need writing. A
      // `SQLITE_BUSY` from the dashboard reading over WAL is ordinary and
      // transient; dropping the batch on it would quietly lose a hundred
      // errors at exactly the moment somebody is looking for them. Newest
      // last, and bounded — see `requeue`.
      this.requeue(batch)
      this.retryAfter = Date.now() + RETRY_BACKOFF_MS
      return
    }

    // Written successfully, so the hot path may flush on size again.
    this.retryAfter = 0

    // Outside the transaction and previously outside any guard, so a locked
    // database turned a successful write into an exception that escaped
    // `flush` — and `flush` is called from every read path, where nothing
    // catches it and the dashboard answers 500.
    try {
      await this.trimEventsFor(new Set(batch.map(event => event.fingerprint)))
    }
    catch (error) {
      // The events are safely written; only the cap was not applied. Retention
      // and the next flush will both try again.
      console.error('[monitor] failed to trim events', error)
    }
  }

  /**
   * Returns a failed batch to the buffer, oldest first, bounded.
   *
   * Unbounded retry against a database that stays broken is how a monitoring
   * tool exhausts the heap of the application it monitors, so the buffer is
   * capped and the oldest events go first: during an ongoing failure the most
   * recent errors are the ones worth keeping.
   */
  private requeue(batch: (MonitorEvent & { fingerprint: string })[]): void {
    this.buffer = [...batch, ...this.buffer]

    if (this.buffer.length <= MAX_PENDING_EVENTS) {
      return
    }

    this.dropped += this.buffer.length - MAX_PENDING_EVENTS
    this.buffer = this.buffer.slice(-MAX_PENDING_EVENTS)

    // Reported as a running total on a timer rather than per drop: a database
    // that stays broken drops on every flush, and a line each would bury the
    // original error under thousands of copies of its consequence.
    this.reportDrops()
  }

  /**
   * Warns that the byte ceiling cannot be met without emptying the database.
   *
   * Throttled like the drop report and for the same reason: this fires on
   * every sweep while the condition lasts, and a line each would bury it.
   */
  private async reportOverCeiling(now = Date.now()): Promise<void> {
    this.overCeiling = true

    if (now < this.nextCeilingReport) {
      return
    }

    this.nextCeilingReport = now + DROP_REPORT_INTERVAL_MS
    console.warn(
      `[monitor] the database holds ${Math.round(await this.bytes() / 1_024)} KB, above the configured `
      + `ceiling of ${Math.round(this.maxBytes / 1_024)} KB, and the most recent `
      + `${MIN_KEPT_EVENTS} events are kept anyway. Raise \`maxDatabaseMb\`.`,
    )
  }

  private reportDrops(now = Date.now()): void {
    if (now < this.nextDropReport) {
      return
    }

    this.nextDropReport = now + DROP_REPORT_INTERVAL_MS
    console.error(`[monitor] dropped ${this.dropped} events that could not be written`)
  }

  /** Applies the per-issue event cap, oldest first. */
  private async trimEventsFor(fingerprints: Set<string>): Promise<void> {
    const trim = this.statement('trim', `
      DELETE FROM events
      WHERE fingerprint = ?
        AND id NOT IN (
          ${this.derived('SELECT id FROM events WHERE fingerprint = ? ORDER BY ts DESC LIMIT ?')}
        )
    `)

    for (const fp of fingerprints) {
      await trim.run(fp, fp, this.options.maxEventsPerIssue)
    }
  }

  /**
   * Enforces the ceiling on how many issues may exist.
   *
   * Retention bounds by age and `maxEventsPerIssue` bounds events *within* an
   * issue, but nothing bounded the number of issues — and that is the axis
   * that actually runs away. A message carrying dynamic text that
   * normalisation cannot strip ("failed for widget kx91#a") gives every
   * occurrence its own fingerprint, so 20k such errors become 20k issues.
   * Measured: 6.4 MB and 527 ms for that one loop, growing with traffic rather
   * than with the size of the application.
   *
   * Eviction is by staleness, then by rarity: an issue nobody has seen lately
   * and which happened twice is the safest thing to lose, and a frequent
   * recent one is what somebody is most likely looking for.
   */
  private async enforceIssueCeiling(): Promise<number> {
    const { n } = await this.db.prepare('SELECT COUNT(*) AS n FROM issues').get() as { n: number }
    const excess = Number(n) - this.maxIssues

    if (excess <= 0) {
      return 0
    }

    const evicted = await this.db.prepare(`
      DELETE FROM issues WHERE fingerprint IN (
        ${this.derived(`SELECT fingerprint FROM issues
          ORDER BY resolved DESC, last_seen ASC, count ASC
          LIMIT ?`)}
      )
    `).run(excess)

    await this.db.prepare(`
      DELETE FROM events WHERE fingerprint NOT IN (SELECT fingerprint FROM issues)
    `).run()

    return changesOf(evicted)
  }

  /**
   * How many bytes the stored data occupies.
   *
   * Pages actually in use, not the size of the file: SQLite keeps emptied
   * pages on a freelist and reuses them, so a file that once spiked stays
   * large on disk while holding very little. Measuring the file would leave
   * the ceiling permanently exceeded after one spike, and every sweep would
   * then delete data to satisfy a number that deleting cannot move.
   */
  async bytes(): Promise<number> {
    // SQLite only. An external database has its own disk and its own
    // monitoring, and `information_schema` is frequently not readable on
    // managed hosting — so the byte ceiling simply does not apply there, and
    // reporting 0 is how `health` and `enforceByteCeiling` are told so.
    if (this.connection.dialect !== 'sqlite') {
      return 0
    }

    const pageCount = await this.pragma('page_count')
    const freeList = await this.pragma('freelist_count')

    return Math.max(0, pageCount - freeList) * await this.pragma('page_size')
  }

  /**
   * What is wrong with the collector itself.
   *
   * A monitoring tool that cannot report on its own state is asking to be
   * trusted on faith: a database that stopped accepting writes, a buffer that
   * is not draining, a ceiling quietly deleting today's errors all look
   * exactly like "no errors happened" from the dashboard.
   */
  async health(): Promise<MonitorHealth> {
    return {
      enabled: true,
      bytes: await this.bytes(),
      maxBytes: this.maxBytes,
      overCeiling: this.overCeiling,
      // Buffered but not yet written. Steadily above zero means flushes are
      // failing, which the drop count then confirms.
      pending: this.buffer.length,
      pendingCounters: this.counters.size,
      dropped: this.dropped,
      // Zero when writes are healthy; a timestamp while backing off.
      retryAfter: this.retryAfter,
      issues: await this.count('issues'),
      events: await this.count('events'),
      retentionDays: this.options.retentionDays,
      maxIssues: this.maxIssues,
    }
  }

  private async count(table: 'issues' | 'events'): Promise<number> {
    // The table name is one of two literals, never user input.
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }

    return Number(row.n)
  }

  /** Reads a single-value PRAGMA. */
  private async pragma(name: string): Promise<number> {
    const row = await this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
    const value = row ? Object.values(row)[0] : 0

    return Number(value ?? 0)
  }

  /**
   * Evicts oldest-first until the stored data fits the byte ceiling.
   *
   * Retention bounds by age and `maxIssues` bounds by count, and neither
   * bounds bytes: an issue may hold a hundred events with long stacks, so a
   * burst of distinct fingerprints fills a disk days before the retention
   * window comes round. On a machine shared with the application being
   * monitored, that is an outage caused by the tool watching for outages.
   *
   * Events go before issues, and oldest before newest, because an old
   * occurrence of an issue that is still happening adds the least: the issue
   * itself, its count and its most recent events all survive.
   *
   * Deletion is in chunks with a re-measure between, since how many bytes a
   * row frees is not knowable in advance — one event may carry a 20 KB stack
   * and the next almost nothing.
   *
   * A floor of `MIN_KEPT_EVENTS` survives regardless. A ceiling set too low
   * for the traffic it meets would otherwise empty the database on every
   * sweep, which reads as "no errors" — the most misleading state a monitoring
   * tool can be in. Better to exceed a misconfigured limit and keep the most
   * recent errors than to answer honestly with nothing.
   */
  private async enforceByteCeiling(): Promise<number> {
    if (this.maxBytes <= 0 || await this.bytes() <= this.maxBytes) {
      // Cleared here rather than only being set: a ceiling raised after the
      // warning, or traffic that quietened down, must stop reporting a
      // condition that no longer holds.
      this.overCeiling = false
      return 0
    }

    const drop = this.statement('evictOldest', `
      DELETE FROM events WHERE id IN (
        ${this.derived('SELECT id FROM events ORDER BY ts ASC LIMIT ?')}
      )
    `)

    const total = this.statement('countEvents', 'SELECT COUNT(*) AS n FROM events')

    let removed = 0

    // Bounded rather than `while (over)`: a ceiling smaller than a single page
    // can never be met, and an unbounded loop would spin against it.
    for (let pass = 0; pass < MAX_EVICTION_PASSES && await this.bytes() > this.maxBytes; pass++) {
      const remaining = Number((await total.get() as { n: number }).n)
      const allowed = Math.min(EVICTION_CHUNK, remaining - MIN_KEPT_EVENTS)

      if (allowed <= 0) {
        // At the floor and still over the ceiling: the limit is set below what
        // this application's errors occupy. Say so, once a minute at most,
        // because silently keeping a database over its stated ceiling is
        // exactly the kind of thing that should not be discovered later.
        await this.reportOverCeiling()
        break
      }

      const changes = changesOf(await drop.run(allowed))

      if (changes === 0) {
        break
      }

      removed += changes

      // Freed pages are returned to the file here. Without this the measured
      // size does drop — `bytes()` counts used pages — but the file on disk
      // does not, and the disk is what runs out.
      await this.reclaim()
    }

    // Issues whose every event has just been evicted would otherwise linger as
    // rows nothing can reach.
    await this.db.prepare(`
      DELETE FROM issues
      WHERE fingerprint NOT IN (SELECT DISTINCT fingerprint FROM events)
    `).run()

    return removed
  }

  /**
   * Returns freed pages to the filesystem.
   *
   * A no-op on databases created before `auto_vacuum` was set, which is why
   * nothing here depends on it having worked.
   */
  private async reclaim(): Promise<void> {
    if (this.connection.dialect !== 'sqlite') {
      return
    }

    try {
      await this.db.exec('PRAGMA incremental_vacuum')
    }
    catch {
      // Not available on this database; the ceiling still bounds what is
      // stored, and the pages stay on the freelist for reuse.
    }
  }

  /**
   * Empties every table, keeping the schema.
   *
   * For tests that share one external server: a leftover row from the previous
   * one makes a count assertion pass or fail for reasons that have nothing to
   * do with what is being tested.
   */
  async reset(): Promise<void> {
    this.buffer = []
    this.counters.clear()

    for (const table of ['events', 'issues', 'request_stats']) {
      await this.db.exec(`DELETE FROM ${table}`)
    }
  }

  /** Drops events past the retention window and issues left with none. */
  async purge(now = Date.now()): Promise<{ events: number, issues: number }> {
    const cutoff = now - this.options.retentionDays * 24 * 60 * 60 * 1_000

    const events = await this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff)

    // Counters are cheap and the chart is more useful with history, so they
    // are kept for longer than the events themselves.
    await this.db.prepare('DELETE FROM request_stats WHERE bucket < ?')
      .run(now - this.options.retentionDays * 3 * 24 * 60 * 60 * 1_000)
    const issues = await this.db.prepare(`
      DELETE FROM issues
      WHERE fingerprint NOT IN (SELECT DISTINCT fingerprint FROM events)
    `).run()

    // Last, and after the count ceiling: both free rows, so measuring bytes
    // before they have run would evict data the cheaper bounds were about to
    // remove anyway.
    const evictedIssues = changesOf(issues) + await this.enforceIssueCeiling()
    const evictedEvents = changesOf(events) + await this.enforceByteCeiling()

    // Retention frees pages too, and without this they stay in the file.
    await this.reclaim()

    return {
      events: evictedEvents,
      // Age alone does not bound a table that grows with the number of
      // distinct fingerprints rather than with time.
      issues: evictedIssues,
    }
  }

  /**
   * Reads.
   *
   * Each flushes first: a just-thrown error the user is looking for would
   * otherwise be missing for up to a second. The flush happens here, once per
   * public call, rather than inside each query — `getEvents` used to flush and
   * then call `getIssue`, which flushed again, and a single dashboard request
   * triggered five.
   */
  async listIssues(filter: Parameters<typeof queries.listIssues>[1] = {}): Promise<{ issues: MonitorIssue[], total: number }> {
    await this.flush()
    return queries.listIssues(this.db, filter)
  }

  async getIssue(fp: string): Promise<MonitorIssue | undefined> {
    await this.flush()
    return queries.getIssue(this.db, fp)
  }

  async getEvents(fp: string, limit = 20, filter?: MonitorFacetFilter): Promise<MonitorEvent[]> {
    await this.flush()
    return queries.getEvents(this.db, fp, limit, filter)
  }

  async facetCounts(scope: Parameters<typeof queries.facetCounts>[1] = {}): Promise<MonitorFacetCounts> {
    await this.flush()
    return queries.facetCounts(this.db, scope)
  }

  async sessionCount(fp: string, filter?: MonitorFacetFilter): Promise<number> {
    await this.flush()
    return queries.sessionCount(this.db, fp, filter)
  }

  async eventCount(fp: string, filter?: MonitorFacetFilter): Promise<number> {
    await this.flush()
    return queries.eventCount(this.db, fp, filter)
  }

  async overview(windowMs = 24 * 60 * 60 * 1_000, now = Date.now()): Promise<MonitorOverview> {
    await this.flush()
    return queries.overview(this.db, windowMs, now)
  }

  async releases(limit = 50): Promise<MonitorRelease[]> {
    await this.flush()
    return queries.releases(this.db, limit)
  }

  async routes(since: number, limit = 100): Promise<MonitorRouteStat[]> {
    await this.flush()
    return queries.routes(this.db, since, limit)
  }

  async sessions(since: number): Promise<MonitorSessionStats> {
    await this.flush()
    return queries.sessions(this.db, since)
  }

  async setResolved(fp: string, resolved: boolean): Promise<boolean> {
    return queries.setResolved(this.db, fp, resolved)
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    await this.flush()
    this.closed = true

    if (this.timer) {
      clearInterval(this.timer)
    }

    // Both timers, or a closed store keeps a retention sweep scheduled against
    // a database handle that is about to go away.
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer)
    }

    // Statements hold the connection open; dropping them before closing keeps
    // a closed store from retaining the database it can no longer use.
    this.statements.clear()
    await this.connection.close()
  }
}
