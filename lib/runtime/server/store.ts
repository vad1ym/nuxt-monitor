import type { Database, Statement } from 'db0'
import type {
  MonitorDelivery,
  MonitorEvent,
  MonitorDeploy,
  MonitorFacetCounts,
  MonitorFacetFilter,
  MonitorHealth,
  MonitorIgnoreOptions,
  MonitorIssue,
  MonitorGroupOptions,
  MonitorIssueReleases,
  MonitorIssueTrend,
  MonitorNotificationOptions,
  MonitorOverview,
  MonitorRelease,
  MonitorRouteStat,
  MonitorSessionStats,
  MonitorTrafficStats,
  MonitorUptimeSummary,
  MonitorHeatCell,
  MonitorDashboard,
} from '../../types'
import type { IssueState } from './notify/triggers'
import { evaluate, evaluateErrorRate, evaluateSilence } from './notify/triggers'
import { MonitorNotifier } from './notify/notifier'
import type { SamplingOptions } from './sampling'
import { Sampler } from './sampling'
import type { ExportOptions } from './export'
import { exportRows } from './export'
import { uptime } from './uptime'
import type { DashboardOptions } from './dashboard'
import { dashboard } from './dashboard'
import type { CompiledIgnore } from '../shared/ignore'
import { compileIgnore, shouldIgnore } from '../shared/ignore'
import { scrubSecrets } from '../shared/scrub'
import type { CompiledGroup } from '../shared/groups'
import { compileGroups, findGroup, groupFor } from '../shared/groups'
import { fingerprint } from '../shared/fingerprint'
import { FAILED_SUM, bucketOf, countedClass, normalizeRoute } from '../shared/route'
import { culpritOf, toIssue } from './rows'
import * as queries from './queries'
import { BUCKET_MS, migrate } from './schema'
import { changesOf, openDatabase, pick, upsertClause } from './db'
import type { MonitorDatabase } from './db'
import type { ParsedUserAgent } from '../shared/user-agent'

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
  /** Alerting. Off when absent or when no channel is configured. */
  notifications?: MonitorNotificationOptions
  /** Admission control per issue. Off unless a burst is set. */
  sampling?: SamplingOptions
  /** Rules that name parts of the application. */
  groups?: MonitorGroupOptions
  /**
   * Turns a stack into the source location to show in the list.
   *
   * Injected rather than imported so the store stays storage-only: resolution
   * reads sourcemaps off disk, and a store that owns a filesystem dependency
   * cannot be opened by the CLI or pointed at an external database without
   * dragging one along.
   *
   * Called **after** the write transaction commits, never inside it. Parsing a
   * map is the expensive part of this module, and doing it between BEGIN and
   * COMMIT would hold a write lock open across disk reads — during an error
   * storm, which is exactly when the buffer is fullest.
   */
  resolveCulprit?: (
    stack: string | undefined,
    options: { trusted: boolean, release?: string },
  ) => Promise<string | undefined>
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
 * How far back the application-wide error rate is measured.
 *
 * Short on purpose. Averaged over a day, a catastrophic ten minutes is a
 * rounding error against the healthy traffic either side of it, and a trigger
 * that cannot fire during an outage is not a trigger.
 */
const ERROR_RATE_WINDOW_MS = 5 * 60_000

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
  /** `bucket facet value` → count. The traffic baseline for breakdowns. */
  private trafficCounters = new Map<string, number>()
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
  /** Absent until a channel is configured; alerting is off by default. */
  private notifier: MonitorNotifier | undefined
  /** Decides which occurrences are written. Inert unless a burst is set. */
  private readonly sampler: Sampler
  /** Occurrences counted but not stored, for health. */
  private sampled = 0
  /** Compiled once at startup, like the ignore rules. */
  private readonly groups: CompiledGroup[]
  /** When the application-wide rate alert last fired. See `raiseErrorRate`. */
  private rateAlertedAt = 0
  /**
   * When the silence alert last fired. Held separately from `rateAlertedAt`
   * because the two describe different conditions, and sharing a cooldown
   * would let a noisy outage suppress the notice that collection had stopped.
   */
  private silenceAlertedAt = 0
  /**
   * Fingerprints somebody has marked as not worth attention.
   *
   * In memory because `capture` is synchronous by design — it runs on the
   * request path and may not touch the database — so the flag has to be
   * readable without a query. Refreshed on every flush, which means a newly
   * ignored issue keeps being stored for at most one flush interval. That is
   * the right trade: the alternative is a read per captured event.
   */
  private ignored = new Set<string>()
  /** Occurrences of ignored issues, counted but not stored. Drained per flush. */
  private ignoredCounts = new Map<string, number>()

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
    this.sampler = new Sampler(options.sampling)
    this.groups = compileGroups(options.groups)

    if (options.notifications) {
      const notifier = new MonitorNotifier(options.notifications, this.db)

      // Kept only when it would actually send. Every alert path then reduces to
      // one `if`, rather than each one re-deriving whether alerting is on.
      this.notifier = notifier.active ? notifier : undefined
    }
  }

  /** The notifier, for the dashboard's test-send and log routes. */
  get alerts(): MonitorNotifier | undefined {
    return this.notifier
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

    /**
     * Credentials out of the message before anything else touches it.
     *
     * Before the fingerprint, deliberately. The message is the identity of an
     * issue, so scrubbing it afterwards would leave the hash keyed on the
     * secret: two occurrences of one bug carrying different tokens would
     * become two issues, and the raw value would live on in the stored
     * message that produced the hash.
     *
     * This is also the one place worth doing it. A message is not just a
     * column — it is the title in the list, the text of every alert about the
     * issue, and a search term. A token there leaks further than one anywhere
     * else in the payload.
     */
    const safe = scrubSecrets(event.message)
    const cleaned = safe === event.message ? event : { ...event, message: safe }

    // The hash is taken from the event as it arrived, before a rule can put a
    // group on it. That ordering is the whole guarantee: a group assigned by a
    // rule is derived from a path, so folding it into the identity would
    // re-key every existing issue the moment somebody turns the option on, and
    // their open work would read as freshly discovered.
    //
    // A group set by `exception()` is already on the event here, and does
    // belong in the hash — there it is a statement by the author that two
    // reports are different concerns.
    const fp = fingerprint(cleaned)

    /**
     * Ignoring an issue stops storing it, not just alerting about it.
     *
     * "Not worth attention" was previously a statement about the list only:
     * every occurrence still cost a buffer slot, a row and its share of the
     * byte ceiling, and an issue is ignored precisely *because* it is noisy —
     * so the loudest thing in the database was the thing nobody wanted. The
     * count still advances, through the same path sampling uses, because "we
     * stopped looking" and "it stopped happening" must not look identical.
     */
    if (this.ignored.has(fp)) {
      this.ignoredCounts.set(fp, (this.ignoredCounts.get(fp) ?? 0) + 1)
      return fp
    }

    const labelled = this.label(cleaned)

    // Admission control, before the event is copied into the buffer. A route
    // failing on every request would otherwise pay the full cost of recording
    // each occurrence and push everything else out of the shared buffer, only
    // for the trimmer to throw most of it away afterwards. The occurrence is
    // still counted — see `drainSampled` — so the issue's total stays true.
    if (!this.sampler.admit(fp)) {
      this.sampled++
      return fp
    }

    this.buffer.push({ ...labelled, fingerprint: fp })

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

  /**
   * Assigns a group from the configured rules, when one matches.
   *
   * The group goes on the event but **not** into the fingerprint, which is the
   * opposite of how `exception()` works — and the asymmetry is deliberate.
   * There the group is part of the identity because the author said so; here
   * it is derived from a path, so folding it into the hash would re-key every
   * existing issue the first time somebody turns the option on, and their open
   * work would read as freshly discovered.
   *
   * An explicit group always wins. `exception(…, { group })` is a statement by
   * whoever wrote the code; a rule is an inference from a coincidence of path.
   */
  private label(event: MonitorEvent): MonitorEvent {
    if (this.groups.length === 0 || event.group) {
      return event
    }

    const context = event.context ?? {}
    const match = groupFor(this.groups, {
      route: typeof context.url === 'string' ? context.url : undefined,
      message: event.message,
    })

    return match ? { ...event, group: match.name } : event
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
      countedClass(status),
    ].join(KEY_SEPARATOR)

    this.counters.set(key, (this.counters.get(key) ?? 0) + 1)

    // A bound on distinct routes seen between flushes, in case normalisation
    // meets something it cannot collapse. Not awaited, for the same reason as
    // in `capture` — this runs on every request.
    if (this.counters.size > 5_000) {
      void this.flushCounters()
    }
  }

  /**
   * Counts one page view's browser and device.
   *
   * The baseline every breakdown is judged against. Aggregated in memory and
   * written with everything else, for the same reason request counters are: a
   * write per request is the opposite of what a monitoring tool should cost.
   */
  countTraffic(agent: ParsedUserAgent, at = Date.now()): void {
    if (this.closed) {
      return
    }

    const bucket = bucketOf(at, BUCKET_MS)

    // Only the dimensions a breakdown can be taken by. `release` is absent on
    // purpose: it describes the build serving the page, not the visitor, so a
    // deploy would make every earlier release look like a vanished audience.
    const dimensions: [string, string | undefined][] = [
      ['browser', agent.browser],
      ['browserVersion', agent.browserVersion],
      ['os', agent.os],
      ['osVersion', agent.osVersion],
      ['deviceType', agent.deviceType],
    ]

    for (const [facet, value] of dimensions) {
      if (!value) {
        continue
      }

      const key = [bucket, facet, value].join(KEY_SEPARATOR)

      this.trafficCounters.set(key, (this.trafficCounters.get(key) ?? 0) + 1)
    }

    if (this.trafficCounters.size > 5_000) {
      void this.flushCounters()
    }
  }

  /** Writes buffered counters. */
  private async flushCounters(): Promise<void> {
    await this.flushTrafficFacets()

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
   * Writes the traffic baseline.
   *
   * Its own transaction, separate from the request counters: these two are
   * independent tallies, and a failure to write one must not roll back the
   * other. On failure the batch is merged back, like the counters — a baseline
   * with holes in it understates an audience and would make a slice look more
   * concentrated than it is.
   */
  private async flushTrafficFacets(): Promise<void> {
    if (this.trafficCounters.size === 0) {
      return
    }

    const batch = this.trafficCounters
    this.trafficCounters = new Map()

    const upsert = this.statement('trafficFacets', `
      INSERT INTO traffic_facets (bucket, facet, value, count)
      VALUES (?, ?, ?, ?)
      ${upsertClause(this.connection.dialect, 'traffic_facets', ['bucket', 'facet', 'value'], ['count = count + excluded.count'])}
    `)

    await this.db.exec('BEGIN')

    try {
      for (const [key, count] of batch) {
        const [bucket, facet, value] = key.split(KEY_SEPARATOR)

        await upsert.run(Number(bucket), facet!, value!, count)
      }

      await this.db.exec('COMMIT')
    }
    catch (error) {
      await this.rollback()
      console.error('[monitor] failed to flush traffic facets', error)

      for (const [key, count] of batch) {
        this.trafficCounters.set(key, (this.trafficCounters.get(key) ?? 0) + count)
      }

      if (this.trafficCounters.size > MAX_PENDING_COUNTERS) {
        const excess = this.trafficCounters.size - MAX_PENDING_COUNTERS

        for (const key of [...this.trafficCounters.keys()].slice(0, excess)) {
          this.trafficCounters.delete(key)
        }
      }
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

    // Before the early return below, because an ignored issue puts nothing in
    // the buffer: its occurrences would otherwise never be attributed, and the
    // list would show a noisy issue frozen at the count it had when somebody
    // silenced it — which reads as "it stopped", the one conclusion this must
    // not invite.
    await this.drainIgnored()
    await this.refreshIgnored()

    if (this.closed || this.buffer.length === 0) {
      // Still drained: a spike that is entirely sampled out after its burst
      // puts nothing in the buffer, and attributing the skipped occurrences
      // only when there is something to write would lose exactly the counts
      // that matter most — the ones from the heaviest spikes.
      await this.drainSampled()

      // And still checked for silence. This is the branch a stopped collector
      // takes — no events, nothing to write — so a check that ran only when
      // there was something to write could never fire on the one condition it
      // exists to detect.
      if (!this.closed) {
        await this.raiseSilence(Date.now())
      }

      return
    }

    const batch = this.buffer
    this.buffer = []

    // Read before the upsert changes them: "was this fingerprint here before,
    // and was it resolved" is unanswerable afterwards, because the upsert's
    // whole job is to make every issue in the batch present and unresolved.
    const before = await this.alertStates(batch)

    // `culprit`/`route`/`method`/`status` keep the freshest location: a moved
    // line is more useful than the one recorded when the issue first appeared.
    // `resolved = 0` reopens an issue that happens again.
    const upsertIssue = this.statement('issue', `
      INSERT INTO issues (
        fingerprint, type, message, side, count, first_seen, last_seen,
        culprit, route, method, status, manual, level, group_name, kind
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${upsertClause(this.connection.dialect, 'issues', ['fingerprint'], [
        'count = count + 1',
        // Extremes, not "whatever arrived last". Assigning `excluded` directly
        // makes both columns describe arrival order rather than when the fault
        // happened, so an event that lands late but happened earlier — a
        // backfill, a queued client batch, a skewed clock — moves `last_seen`
        // backwards past `first_seen`. The span between them then reads as
        // negative, and anything derived from it is nonsense.
        // Written unqualified, like the other assignments: `upsertClause`
        // adds the table prefix Postgres needs, and a reference qualified here
        // would come back as `issues.issues.last_seen`.
        `last_seen = ${pick(this.connection.dialect, 'max', 'last_seen', 'excluded.last_seen')}`,
        `first_seen = ${pick(this.connection.dialect, 'min', 'first_seen', 'excluded.first_seen')}`,
        'culprit = COALESCE(excluded.culprit, culprit)',
        'route = COALESCE(excluded.route, route)',
        'method = COALESCE(excluded.method, method)',
        'status = COALESCE(excluded.status, status)',
        // Never unset by a later occurrence, and never re-derived: `manual`,
        // the group and the level are decided at the call site that raised the
        // issue, and the group is part of the fingerprint, so every occurrence
        // of this issue carries the same one by construction.
        'manual = COALESCE(excluded.manual, manual)',
        'level = COALESCE(excluded.level, level)',
        'group_name = COALESCE(excluded.group_name, group_name)',
        'kind = COALESCE(excluded.kind, kind)',
        // The moment a fix was disproved, kept before the flag that erases it.
        // Written only when the row was actually resolved — every ordinary
        // occurrence of an open issue runs through here too, and stamping
        // those would make every issue look like a regression.
        'regressed_at = CASE WHEN resolved = 1 THEN excluded.last_seen ELSE regressed_at END',
        'resolved = 0',
      ])}
    `)

    const insertEvent = this.statement('event', `
      INSERT INTO events (
        fingerprint, ts, stack, context, breadcrumbs, tags, message,
        session, browser, browser_version, os, os_version, device_type, \`release\`, route,
        manual, level, group_name, kind
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          event.manual ? 1 : null,
          event.level ?? null,
          event.group ?? null,
          event.kind ?? null,
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
          event.manual ? 1 : null,
          event.level ?? null,
          event.group ?? null,
          event.kind ?? null,
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

    // After the commit, not before it. The first occurrence of any fingerprint
    // is inside the burst and therefore in this batch, so an issue sampled for
    // the first time has no row until the transaction above has run — and an
    // UPDATE against a row that does not exist yet silently counts nothing.
    // That is how a spike of fifty came out as two.
    await this.drainSampled()

    // Also after the commit, and for the same reason as the two around it: the
    // row has to exist before an UPDATE can name it.
    try {
      await this.resolveCulprits(batch)
    }
    catch (error) {
      // A name is a convenience; the events are written either way, and the
      // issue page resolves the stack again when somebody opens it.
      console.error('[monitor] failed to resolve culprits', error)
    }

    // After the commit, never before: an alert about an issue that a rolled-back
    // transaction did not write points at a fingerprint the dashboard does not
    // have, and the link in the message leads to a 404.
    try {
      await this.raiseAlerts(before)
    }
    catch (error) {
      // Alerting is downstream of collection and must not undo it. The events
      // are written either way.
      console.error('[monitor] failed to evaluate alerts', error)
    }

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
   * Adds up the occurrences of ignored issues without storing any of them.
   *
   * The same bargain sampling makes, for the same reason: an issue may stop
   * being *stored* but must never stop being *counted*. "Ignored, 12
   * occurrences" three weeks after somebody silenced a route that has failed
   * forty thousand times since would be a lie the list told quietly, and
   * un-ignoring it would appear to resurrect a dead issue.
   *
   * `last_seen` moves too, so the row still says when it last happened.
   */
  private async drainIgnored(): Promise<void> {
    if (!this.ignoredCounts.size) {
      return
    }

    const owed = [...this.ignoredCounts]
    this.ignoredCounts.clear()

    const now = Date.now()

    for (const [fp, count] of owed) {
      await this.db
        .prepare('UPDATE issues SET count = count + ?, last_seen = ? WHERE fingerprint = ?')
        .run(count, now, fp)
    }
  }

  /**
   * Re-reads which issues are ignored, so `capture` can check without a query.
   *
   * Bounded by the same ceiling as the issue table, and in practice tiny: this
   * is the set somebody has explicitly clicked away, not every issue.
   */
  private async refreshIgnored(): Promise<void> {
    const rows = await this.db
      .prepare('SELECT fingerprint FROM issues WHERE ignored = 1')
      .all() as { fingerprint: string }[]

    this.ignored = new Set(rows.map(row => String(row.fingerprint)))
  }

  /**
   * Replaces the built-file guess with the source location, once per issue.
   *
   * The list is where a person decides what to open, and `dev/index.mjs:8484`
   * is not a decision anybody can make. Until now the better name appeared
   * only after somebody opened the issue — so a new issue looked worst exactly
   * when it was seen first, and searching for `server/api/orders.ts` did not
   * find it until an unrelated visit had happened.
   *
   * Only for fingerprints new to this batch, and only when the stored name
   * still looks unresolved. A repeat occurrence of a known issue has nothing
   * to add: the name is already right, and re-parsing a map per event would
   * turn a cheap flush into a proportional one.
   */
  private async resolveCulprits(batch: (MonitorEvent & { fingerprint: string })[]): Promise<void> {
    const resolve = this.options.resolveCulprit

    if (!resolve) {
      return
    }

    // One event per fingerprint — the first, which is the one whose stack the
    // issue's name should come from.
    const first = new Map<string, MonitorEvent & { fingerprint: string }>()

    for (const event of batch) {
      if (!first.has(event.fingerprint)) {
        first.set(event.fingerprint, event)
      }
    }

    for (const [fingerprint, event] of first) {
      const culprit = await resolve(event.stack, {
        // Client stacks arrive through unauthenticated ingest, so the file
        // they name is the sender's choice: they may only resolve against
        // published build assets, never an arbitrary path on disk.
        trusted: event.side === 'server',
        release: event.facets?.release,
      })

      if (!culprit) {
        continue
      }

      // `COALESCE` is wrong here: the stored value is the raw-stack guess, and
      // the whole point is to overwrite it. Guarded on inequality instead, so
      // an unchanged name costs no write.
      await this.db
        .prepare('UPDATE issues SET culprit = ? WHERE fingerprint = ? AND (culprit IS NULL OR culprit != ?)')
        .run(culprit, fingerprint, culprit)
    }
  }

  /**
   * Adds the occurrences that were counted but not stored.
   *
   * This is what keeps sampling honest. Under-reporting how often something
   * happened is the one failure a monitoring tool cannot afford — "12
   * occurrences" when it was 40,000 reads as a curiosity rather than an
   * emergency — so an issue's count advances by every occurrence, and only the
   * event bodies are thinned.
   *
   * Only ever touches issues that already exist: the first occurrence of any
   * fingerprint is inside the burst and therefore always stored, so a row is
   * present before any of its occurrences can be sampled out.
   */
  private async drainSampled(): Promise<void> {
    if (!this.sampler.active) {
      return
    }

    const owed = this.sampler.drainPending()

    if (owed.size === 0) {
      return
    }

    const bump = this.statement('bumpCount', `
      UPDATE issues SET count = count + ?, last_seen = ${pick(this.connection.dialect, 'max', 'last_seen', '?')}
      WHERE fingerprint = ?
    `)

    const now = Date.now()

    try {
      for (const [fp, weight] of owed) {
        // `last_seen` moves too: a fault whose occurrences are being sampled is
        // by definition still happening, and an issue that looks stale while it
        // fires forty times a second is worse than one that is merely thinned.
        await bump.run(weight, now, fp)
      }
    }
    catch (error) {
      console.error('[monitor] failed to record sampled occurrences', error)
    }
  }

  /**
   * How the issues in a batch stood before it was written.
   *
   * One query for the whole batch rather than one per event: a flush of a
   * hundred events touches a handful of distinct fingerprints, and asking about
   * each separately would put a hundred round trips on a path that exists to
   * batch them.
   */
  private async alertStates(
    batch: (MonitorEvent & { fingerprint: string })[],
  ): Promise<Map<string, IssueState>> {
    const states = new Map<string, IssueState>()

    if (!this.notifier) {
      return states
    }

    const fingerprints = [...new Set(batch.map(event => event.fingerprint))]
    const placeholders = fingerprints.map(() => '?').join(', ')

    const rows = await this.db.prepare(`
      SELECT fingerprint, count, resolved, alerted_at, alerted_count, first_seen, last_seen
      FROM issues WHERE fingerprint IN (${placeholders})
    `).all(...fingerprints) as Record<string, unknown>[]

    // What this flush is about to add, per fingerprint, and over how long. The
    // spike trigger compares one against the other, and both are knowable only
    // here — the batch is gone by the time the rows are re-read.
    const added = new Map<string, { count: number, first: number, last: number }>()

    for (const event of batch) {
      const seen = added.get(event.fingerprint)

      if (seen) {
        seen.count += 1
        seen.first = Math.min(seen.first, event.timestamp)
        seen.last = Math.max(seen.last, event.timestamp)
      }
      else {
        added.set(event.fingerprint, { count: 1, first: event.timestamp, last: event.timestamp })
      }
    }

    for (const row of rows) {
      const fp = String(row.fingerprint)
      const previousCount = Number(row.count ?? 0)
      const firstSeen = Number(row.first_seen ?? 0)
      const lastSeen = Number(row.last_seen ?? 0)
      const history = lastSeen - firstSeen
      const batched = added.get(fp)

      states.set(fp, {
        previousCount,
        wasResolved: Number(row.resolved ?? 0) === 1,
        alertedCount: Number(row.alerted_count ?? 0),
        alertedAt: Number(row.alerted_at ?? 0),
        // Left undefined when the issue has no span to average over: everything
        // it has ever done happened inside one instant, so it has no "usual".
        ratePerMinute: history > 0 ? previousCount / (history / 60_000) : undefined,
        addedCount: batched?.count,
        // The span these occurrences actually cover, not the wall-clock gap
        // since the last flush. A batch of forty stamped across two seconds is
        // a spike whether it was written promptly or after a retry.
        spanMs: batched ? Math.max(1, batched.last - batched.first) : undefined,
      })
    }

    // A fingerprint with no row is new, which is the state the `new-issue`
    // trigger is looking for. Left absent rather than defaulted at the read
    // site so the distinction stays explicit.
    for (const fp of fingerprints) {
      if (!states.has(fp)) {
        states.set(fp, { previousCount: 0, wasResolved: false, alertedCount: 0, alertedAt: 0 })
      }
    }

    return states
  }

  /**
   * Queues alerts for the issues this flush changed.
   *
   * The cooldown is applied here rather than in the notifier because it is per
   * issue and its state lives on the issue row — which is what makes it survive
   * a restart. A cooldown held in memory would reset on every deploy, and a
   * deploy is when the alerts are firing.
   */
  private async raiseAlerts(before: Map<string, IssueState>): Promise<void> {
    if (!this.notifier || before.size === 0) {
      return
    }

    const now = Date.now()
    const cooldown = this.notifier.cooldownMs
    const fingerprints = [...before.keys()]
    const placeholders = fingerprints.map(() => '?').join(', ')

    const rows = await this.db.prepare(`
      SELECT * FROM issues WHERE fingerprint IN (${placeholders})
    `).all(...fingerprints) as Record<string, unknown>[]

    for (const row of rows) {
      const state = before.get(String(row.fingerprint))

      if (!state) {
        continue
      }

      const issue = toIssue(row)
      const watched = Boolean(issue.group && findGroup(this.groups, issue.group)?.notify)
      const alert = evaluate(issue, state, this.options.notifications?.triggers, now, watched)

      if (!alert) {
        continue
      }

      // A new issue and a regression are each announced once and are therefore
      // not the noise the cooldown exists to stop — but they still start it, so
      // that the thousand occurrences behind them stay quiet.
      if ((alert.reason === 'threshold' || alert.reason === 'watched') && now - state.alertedAt < cooldown) {
        continue
      }

      this.notifier.enqueue(alert)

      // Written before the send, not after: the message goes out detached, and
      // a cooldown recorded only on success would let a failing channel raise
      // the same alert on every flush for as long as it stays broken.
      await this.db.prepare(
        'UPDATE issues SET alerted_at = ?, alerted_count = ? WHERE fingerprint = ?',
      ).run(now, Math.max(state.alertedCount, alert.threshold ?? 0), String(row.fingerprint))
    }

    await this.raiseErrorRate(now)
  }

  /**
   * The one alert that is about the application rather than about an issue.
   *
   * Evaluated once per flush over the last few minutes of counted requests, so
   * it can fire in a flush where no single issue was remarkable — fifty small
   * faults, each under every threshold, are still a checkout nobody completes.
   *
   * Its cooldown is held in memory rather than on a row, which is the one place
   * this differs from the per-issue cooldown and is a deliberate trade: there is
   * no row to hang it on, and the failure mode of losing it on a restart is one
   * extra message during an outage that is already sending them.
   */
  private async raiseErrorRate(now: number): Promise<void> {
    const triggers = this.options.notifications?.triggers

    if (!this.notifier || triggers?.errorRate === undefined) {
      return
    }

    if (now - this.rateAlertedAt < this.notifier.cooldownMs) {
      return
    }

    // The same bucket size the counters are written in, over a short window:
    // an error rate averaged across a day cannot cross anything, because a bad
    // ten minutes is a rounding error against 24 hours of healthy traffic.
    const since = bucketOf(now - ERROR_RATE_WINDOW_MS, BUCKET_MS)

    // `class` is the status class as text — `'5xx'`, not the number 5. Written
    // the way every other failure count in this module is, because the two
    // spellings differ by nothing visible and the wrong one matches no row at
    // all: the trigger would simply never fire, and silence is what it looks
    // like when it is working.
    const counts = await this.db.prepare(`
      SELECT
        COALESCE(SUM(count), 0)                                     AS total,
        ${FAILED_SUM} AS failed
      FROM request_stats WHERE bucket >= ?
    `).get(since) as { total: number | null, failed: number | null }

    const alert = evaluateErrorRate(
      { failed: Number(counts.failed ?? 0), total: Number(counts.total ?? 0) },
      triggers,
      now,
    )

    if (!alert) {
      return
    }

    this.rateAlertedAt = now
    this.notifier.enqueue(alert)
  }

  /**
   * The alert that fires when nothing has arrived at all.
   *
   * Runs on the flush timer rather than on the flush *contents*, which is the
   * whole point: this is the only condition here that produces no events, so a
   * check driven by events could never observe it. The timer ticks whether or
   * not anything happened, and this is called on both paths.
   *
   * Its cooldown is `silenceAlertedAt` rather than the notifier's own, so a
   * quiet week says something once every cooldown instead of once — and does
   * not compete with the rate alert's cooldown, which is about a different
   * condition entirely.
   */
  private async raiseSilence(now: number): Promise<void> {
    const triggers = this.options.notifications?.triggers

    if (!this.notifier || !triggers?.silence) {
      return
    }

    if (now - this.silenceAlertedAt < this.notifier.cooldownMs) {
      return
    }

    /**
     * The last sign of life, from either source.
     *
     * Both, because they fail independently and either one alone would lie: a
     * browser collector that stopped reporting leaves server requests still
     * arriving, and an application serving no traffic at all still counts as
     * observed if its error collector is alive. The most recent of the two is
     * the honest answer to "when did we last hear anything".
     */
    const seen = await this.db.prepare(`
      SELECT
        (SELECT MAX(ts) FROM events)                AS last_event,
        (SELECT MAX(bucket) FROM request_stats)     AS last_request,
        (SELECT MIN(bucket) FROM request_stats)     AS first_request,
        (SELECT COALESCE(SUM(count), 0) FROM request_stats) AS requests
    `).get() as Record<string, number | null>

    const lastSeen = Math.max(Number(seen.last_event ?? 0), Number(seen.last_request ?? 0))
    const firstSeen = Number(seen.first_request ?? 0)

    // Nothing has ever been recorded, so there is no silence to report — only
    // an application that has not started yet.
    if (!lastSeen || !firstSeen) {
      return
    }

    const alert = evaluateSilence(
      {
        lastSeen,
        observedMs: now - firstSeen,
        requests: Number(seen.requests ?? 0),
      },
      triggers,
      now,
    )

    if (!alert) {
      return
    }

    this.silenceAlertedAt = now
    this.notifier.enqueue(alert)
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
      // Surfaced because a sampled database looks like a quiet one from the
      // inside: fewer stored occurrences than an issue's count, and no
      // indication why. Counts stay exact; this says the bodies behind them do
      // not all exist.
      sampling: this.sampler.active,
      sampled: this.sampled,
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

    this.trafficCounters.clear()

    for (const table of ['events', 'issues', 'request_stats', 'traffic_facets', 'notifications']) {
      await this.db.exec(`DELETE FROM ${table}`)
    }
  }

  /** Drops events past the retention window and issues left with none. */
  async purge(now = Date.now()): Promise<{ events: number, issues: number }> {
    const cutoff = now - this.options.retentionDays * 24 * 60 * 60 * 1_000

    const events = await this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff)

    // Counters are cheap and the chart is more useful with history, so they
    // are kept for longer than the events themselves.
    const counterCutoff = now - this.options.retentionDays * 3 * 24 * 60 * 60 * 1_000

    await this.db.prepare('DELETE FROM request_stats WHERE bucket < ?').run(counterCutoff)
    // Kept exactly as long as the request counters: both are the denominators
    // that give the error numbers meaning, and a baseline that expired first
    // would silently stop qualifying the breakdowns.
    await this.db.prepare('DELETE FROM traffic_facets WHERE bucket < ?').run(counterCutoff)
    const issues = await this.db.prepare(`
      DELETE FROM issues
      WHERE fingerprint NOT IN (SELECT DISTINCT fingerprint FROM events)
    `).run()

    // Last, and after the count ceiling: both free rows, so measuring bytes
    // before they have run would evict data the cheaper bounds were about to
    // remove anyway.
    const evictedIssues = changesOf(issues) + await this.enforceIssueCeiling()
    const evictedEvents = changesOf(events) + await this.enforceByteCeiling()

    // The log has no per-row cap of its own and is written on every alert, so
    // the sweep is the only thing bounding it.
    await this.notifier?.trimLog()

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

  async issueTrend(
    fp: string,
    filter?: MonitorFacetFilter,
    from?: number,
  ): Promise<MonitorIssueTrend> {
    await this.flush()
    return queries.issueTrend(this.db, fp, filter, undefined, from)
  }

  /** The release already running at a moment, for starting a chart before it. */
  async deployBefore(moment: number): Promise<MonitorDeploy | undefined> {
    await this.flush()
    return queries.deployBefore(this.db, moment)
  }

  /** Which releases one issue was first and last seen in. */
  async issueReleases(fp: string): Promise<MonitorIssueReleases | undefined> {
    await this.flush()
    return queries.issueReleases(this.db, fp)
  }

  /** Sessions on this issue against sessions seeing any error in its span. */
  async sessionShare(
    fp: string,
    filter?: MonitorFacetFilter,
  ): Promise<{ affected: number, total: number } | undefined> {
    await this.flush()
    return queries.sessionShare(this.db, fp, filter)
  }

  /** The deploys that landed inside a span, for drawing on an issue's chart. */
  async deploysBetween(from: number, to: number): Promise<MonitorDeploy[]> {
    await this.flush()
    return queries.deploysBetween(this.db, from, to)
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

  async traffic(windowMs: number): Promise<MonitorTrafficStats> {
    await this.flush()
    return queries.traffic(this.db, windowMs)
  }

  async sessions(since: number): Promise<MonitorSessionStats> {
    await this.flush()
    return queries.sessions(this.db, since)
  }

  /**
   * Streams the stored data out, a chunk at a time.
   *
   * Not `async` and not awaited: it hands back the generator so the caller
   * pulls pages at its own pace. Callers flush first when they need pending
   * events included — the route does.
   */
  exportRows(options: ExportOptions): AsyncGenerator<string> {
    return exportRows(this.db, options)
  }

  /**
   * The traffic baseline over a window.
   *
   * Flushes first, like every other read: the counters buffered since the last
   * write belong in the answer, and on a quiet application they may be most of
   * it.
   */
  async trafficFacets(windowMs: number): Promise<MonitorFacetCounts> {
    await this.flush()
    return queries.trafficFacets(this.db, windowMs)
  }

  /** Everything the dashboard screen draws, in one round trip. */
  async dashboard(options: DashboardOptions): Promise<MonitorDashboard> {
    await this.flush()
    return dashboard(this.db, options)
  }

  /** Errors by hour and weekday, for the heat map. */
  async heatmap(since: number): Promise<MonitorHeatCell[]> {
    await this.flush()
    return queries.heatmap(this.db, since)
  }

  /**
   * How the last months went, a day at a time.
   *
   * The watched groups come from the config rather than the caller: which
   * parts of the application matter is a property of the installation, and a
   * dashboard that could pass its own list would be able to disagree with the
   * alerts about what counts as serious.
   */
  async uptime(days = 90): Promise<MonitorUptimeSummary> {
    await this.flush()

    return uptime(this.db, {
      days,
      watched: this.groups.filter(group => group.notify).map(group => group.name),
    })
  }

  /** The alert delivery log, newest first. No flush: nothing buffers into it. */
  async deliveries(limit = 100): Promise<MonitorDelivery[]> {
    return queries.deliveries(this.db, limit)
  }

  async setCulprit(fp: string, culprit: string): Promise<boolean> {
    return queries.setCulprit(this.db, fp, culprit)
  }

  async setResolved(fp: string, resolved: boolean): Promise<boolean> {
    return queries.setResolved(this.db, fp, resolved)
  }

  async setIgnored(fp: string, ignored: boolean): Promise<boolean> {
    const result = await queries.setIgnored(this.db, fp, ignored)

    // Applied to the in-memory set now rather than at the next flush. Both
    // directions matter and the second one more: somebody who un-ignores an
    // issue is about to watch for it, and a minute of continued silence looks
    // exactly like the button not working.
    if (ignored) {
      this.ignored.add(fp)
    }
    else {
      this.ignored.delete(fp)
    }

    return result
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    await this.flush()

    // Before `closed`, so the flush above can still queue alerts, and awaited
    // so a group window still open at shutdown is sent rather than lost — the
    // error that precedes a process going away is one worth hearing about.
    await this.notifier?.close()

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
