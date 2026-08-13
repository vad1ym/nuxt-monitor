import type { Database } from 'db0'
import type {
  MonitorDelivery,
  MonitorEvent,
  MonitorFacetCounts,
  MonitorFacetFilter,
  MonitorFacetName,
  MonitorHeatCell,
  MonitorIssue,
  MonitorIssueTrend,
  MonitorLevel,
  MonitorRouteKind,
  MonitorOverview,
  MonitorRelease,
  MonitorRouteStat,
  MonitorSessionStats,
  MonitorTrafficStats,
  MonitorSide,
} from '../../types'
import { FACET_NAMES, facetClause, facetColumn } from './facets'
import { escapeLike, parseJson, toFacets, toIssue } from './rows'
import { bucketOf } from '../shared/route'
import { BUCKET_MS } from './schema'
import { changesOf } from './db'

/**
 * Reads.
 *
 * Free functions over a connection rather than methods, because none of this
 * touches the buffering machinery in `MonitorStore` — the write path owns the
 * buffer, the counters and the timers, and the read path only ever needed
 * `db`. That was the seam the file was split along.
 *
 * Callers are responsible for flushing first when they need pending events to
 * be visible; `MonitorStore` does that once per public read rather than each of
 * these doing it again on every internal call.
 */

/**
 * How the list is ordered.
 *
 * The order used to be fixed and unnamed, which left the screen unable to say
 * whether it was showing the newest or the worst — two different questions,
 * both asked daily. `first-seen` is the third: it is what "what appeared
 * today" means.
 */
export type MonitorIssueSort = 'last-seen' | 'count' | 'first-seen'

const ORDER: Record<MonitorIssueSort, string> = {
  'last-seen': 'last_seen DESC',
  'count': 'count DESC, last_seen DESC',
  'first-seen': 'first_seen DESC',
}

/**
 * Facet values per page.
 *
 * Enough that the common facets — browser, device, release — arrive whole and
 * the panel never asks twice. Route is the one that routinely runs longer, and
 * it is also the one where the tail is worth reading.
 */
const FACET_PAGE = 20

export async function listIssues(db: Database, filter: {
  side?: MonitorSide
  resolved?: boolean
  /** Free text, matched against message, type, location and route. */
  search?: string
  /** Exact error type, e.g. `TypeError`. */
  type?: string
  /** Keeps only issues with at least one occurrence matching every facet. */
  facets?: MonitorFacetFilter
  /** Ignored issues are hidden unless this asks for them. */
  ignored?: boolean
  /** `true` keeps only `exception()` reports; `false` keeps only caught errors. */
  manual?: boolean
  /** A named priority group, from `exception(msg, { group })`. */
  group?: string
  level?: MonitorLevel
  /** `api`, `page` or `asset`. */
  kind?: MonitorRouteKind
  sort?: MonitorIssueSort
  limit?: number
  offset?: number
} = {}): Promise<{ issues: MonitorIssue[], total: number }> {
  // Pending events belong in the answer; a just-thrown error the user is
  // looking for would otherwise be missing for up to a second.
  const where: string[] = []
  const params: (string | number)[] = []

  if (filter.side) {
    where.push('side = ?')
    params.push(filter.side)
  }

  if (filter.resolved !== undefined) {
    where.push('resolved = ?')
    params.push(filter.resolved ? 1 : 0)
  }

  if (filter.type) {
    where.push('type = ?')
    params.push(filter.type)
  }

  // Reports raised by hand, on their own. They answer a different question
  // from a caught error — "what did somebody decide was worth watching" rather
  // than "what broke" — and mixing the two makes the smaller set unfindable.
  if (filter.manual !== undefined) {
    where.push(filter.manual ? 'manual = 1' : '(manual IS NULL OR manual = 0)')
  }

  if (filter.group) {
    where.push('group_name = ?')
    params.push(filter.group)
  }

  if (filter.level) {
    where.push('level = ?')
    params.push(filter.level)
  }

  // Endpoint failures and page failures are usually different people's work,
  // so they are worth separating even though both say `side: 'server'`.
  if (filter.kind) {
    where.push('kind = ?')
    params.push(filter.kind)
  }

  // Absent means "not ignored" rather than "either": noise that has been put
  // aside should stay aside without every caller remembering to say so.
  // `IS NULL` is carried because rows written before the column existed have
  // no value, and they are not ignored.
  where.push(filter.ignored ? 'ignored = 1' : '(ignored IS NULL OR ignored = 0)')

  if (filter.search) {
    // Searching the fields a person would recall: what it said, what kind of
    // error it was, which file, which route.
    where.push(
      '(message LIKE ? ESCAPE \'\\\' OR type LIKE ? ESCAPE \'\\\' '
      + 'OR culprit LIKE ? ESCAPE \'\\\' OR route LIKE ? ESCAPE \'\\\')',
    )

    // `escapeLike` keeps a literal `%` in a search term from matching
    // everything.
    const pattern = `%${escapeLike(filter.search)}%`
    params.push(pattern, pattern, pattern, pattern)
  }

  // Facets live on events, so an issue qualifies when any one of its
  // occurrences matches. EXISTS rather than a join: a join would multiply the
  // issue row by its matching events and inflate both the list and the count.
  const facets = facetClause(filter.facets)

  if (facets.sql) {
    where.push(`EXISTS (
      SELECT 1 FROM events
      WHERE events.fingerprint = issues.fingerprint ${facets.sql}
    )`)
    params.push(...facets.params)
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(filter.limit ?? 50, 200)
  const offset = filter.offset ?? 0

  // Looked up from a fixed table, never interpolated from the request: this
  // string lands in SQL, and a caller-supplied one would be an injection.
  const order = ORDER[filter.sort ?? 'last-seen'] ?? ORDER['last-seen']

  const rows = await db.prepare(`
    SELECT * FROM issues ${clause} ORDER BY ${order} LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[]

  const total = await db.prepare(`
    SELECT COUNT(*) AS n FROM issues ${clause}
  `).get(...params) as { n: number }

  return {
    issues: rows.map(toIssue),
    total: Number(total.n),
  }
}

export async function getIssue(db: Database, fp: string): Promise<MonitorIssue | undefined> {
  const row = await db.prepare('SELECT * FROM issues WHERE fingerprint = ?')
    .get(fp) as Record<string, unknown> | undefined

  return row ? toIssue(row) : undefined
}

/**
 * Occurrences of an issue, newest first.
 *
 * Takes the same facet filter as the breakdown, so clicking a slice — "show
 * me the iOS 16 ones" — narrows the stacks on screen to that slice.
 */
export async function getEvents(db: Database, fp: string, limit = 20, filter?: MonitorFacetFilter): Promise<MonitorEvent[]> {
  const facets = facetClause(filter)

  const rows = await db.prepare(`
    SELECT * FROM events
    WHERE fingerprint = ? ${facets.sql}
    ORDER BY ts DESC LIMIT ?
  `).all(fp, ...facets.params, Math.min(limit, 100)) as Record<string, unknown>[]

  const issue = await getIssue(db, fp)

  return rows.map(row => ({
    // Side and type are part of the fingerprint, so every occurrence behind
    // one issue genuinely shares them.
    side: (issue?.side ?? 'server') as MonitorSide,
    type: issue?.type ?? 'Error',
    // The message is not: fingerprinting normalises it, so occurrences with
    // different ids group together and each keeps its own text. Rows written
    // before this column existed fall back to the issue's.
    message: (row.message as string | null) ?? issue?.message ?? '',
    timestamp: Number(row.ts),
    stack: (row.stack as string | null) ?? undefined,
    context: parseJson<Record<string, unknown>>(row.context as string | null),
    breadcrumbs: parseJson(row.breadcrumbs as string | null),
    tags: parseJson(row.tags as string | null),
    facets: toFacets(row),
  }))
}

/**
 * Counts every facet value over a set of events.
 *
 * One query per facet rather than one grouped query: a single pass would
 * have to cross-join the dimensions, which multiplies rows for an answer
 * nobody asked — the panel shows each dimension independently.
 *
 * `scope.fingerprint` restricts to one issue (the breakdown inside an issue);
 * without it the counts cover the whole window (the panel beside the list).
 */
export async function facetCounts(db: Database, scope: {
  fingerprint?: string
  since?: number
  filter?: MonitorFacetFilter
  /** Values per facet. The panel raises it to show the rest of a long list. */
  limit?: number
} = {}): Promise<MonitorFacetCounts> {
  const where: string[] = []
  const params: (string | number)[] = []

  if (scope.fingerprint) {
    where.push('fingerprint = ?')
    params.push(scope.fingerprint)
  }

  if (scope.since !== undefined) {
    where.push('ts >= ?')
    params.push(scope.since)
  }

  const facets = facetClause(scope.filter)

  // `facetClause` prefixes each of its conditions with AND, so it needs
  // something to hang off. `1 = 1` keeps the two independent: a filter with
  // no scope is as valid as a scope with no filter, and building the clause
  // conditionally is how the parameters and the SQL drift apart.
  const clause = where.length || facets.sql
    ? `WHERE ${where.length ? where.join(' AND ') : '1 = 1'} ${facets.sql}`
    : ''

  const counts = {} as MonitorFacetCounts
  const limit = Math.min(Math.max(scope.limit ?? FACET_PAGE, 1), 200)

  // Every event in scope carries a value for every facet — `unknown` when the
  // column is null — so the number of events is the denominator, whichever
  // facet is being counted. Asked once, outside the loop, for that reason.
  //
  // Summing the returned rows instead, as this did, divided by the top 20
  // alone: with more values than that each share was inflated by whatever the
  // tail held, and the visible ones added up to 100% while describing a
  // fraction of the events. The bars were wrong in exactly the case the limit
  // exists for.
  const [scoped] = await db.prepare(`
    SELECT COUNT(*) AS n FROM events ${clause}
  `).all(...params, ...facets.params) as { n: number }[]

  const total = Number(scoped?.n ?? 0)

  for (const name of FACET_NAMES) {
    const column = facetColumn(name)

    // One extra row, discarded before it is returned: it is how the panel
    // learns there is a next page without paying for a second COUNT query.
    const rows = await db.prepare(`
      SELECT COALESCE(${column}, 'unknown') AS value, COUNT(*) AS n
      FROM events
      ${clause}
      GROUP BY value
      -- The value breaks ties, so a panel does not reshuffle equal rows
      -- between refreshes.
      ORDER BY n DESC, value ASC
      LIMIT ?
    `).all(...params, ...facets.params, limit + 1) as { value: string, n: number }[]

    counts[name] = {
      values: rows.slice(0, limit).map(row => ({
        value: String(row.value),
        count: Number(row.n),
        share: total ? Number(row.n) / total : 0,
      })),
      // The extra row never leaves the server; its existence is the answer.
      more: rows.length > limit,
    }
  }

  return counts
}

/**
 * How many distinct sessions are behind an issue.
 *
 * The number that separates "one person hit reload 200 times" from "200
 * people are stuck", which is the first thing worth knowing and is invisible
 * in an event count. Server events have no session, so they are counted by
 * event instead — a server error is per-request by nature.
 */
export async function sessionCount(db: Database, fp: string, filter?: MonitorFacetFilter): Promise<number> {
  const facets = facetClause(filter)

  const row = await db.prepare(`
    SELECT COUNT(DISTINCT session) AS n
    FROM events
    WHERE fingerprint = ? AND session IS NOT NULL ${facets.sql}
  `).get(fp, ...facets.params) as { n: number }

  return Number(row.n)
}

/**
 * Stored occurrences of an issue, optionally narrowed by facet.
 *
 * Not the same as `issue.count`, which counts every occurrence ever seen:
 * events past `maxEventsPerIssue` or the retention window are gone, and a
 * filter removes more. A breakdown has to add up to what it is a breakdown
 * of, so the screen showing slices shows this number beside them.
 */
export async function eventCount(db: Database, fp: string, filter?: MonitorFacetFilter): Promise<number> {
  const facets = facetClause(filter)

  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM events WHERE fingerprint = ? ${facets.sql}
  `).get(fp, ...facets.params) as { n: number }

  return Number(row.n)
}

/**
 * Which releases one issue spans.
 *
 * "Introduced in 1.8.2, last seen in 1.8.3" is the sentence somebody wants
 * before reading a line of the stack: it says whether a deploy caused this,
 * and whether the deploy after it fixed it. Neither is answerable from a
 * timestamp — release names are what people compare, and the mapping from one
 * to the other lives in a deploy log nobody has open.
 *
 * Taken from the occurrences rather than from the issue row, because the issue
 * row has no release: an issue exists across all of them by construction.
 *
 * The caveat that has to travel with this number: `maxEventsPerIssue` trims
 * the oldest occurrences, so a long-lived busy issue can lose the evidence of
 * where it began and appear to have been introduced by whichever release the
 * surviving rows start in. `partial` says when that is possible, and the
 * screen says so rather than asserting a release that may be innocent.
 */
export async function issueReleases(
  db: Database,
  fp: string,
): Promise<{ first?: string, last?: string, count: number, partial: boolean } | undefined> {
  const rows = await db.prepare(`
    SELECT release, MIN(ts) AS first_seen, MAX(ts) AS last_seen
    FROM events
    WHERE fingerprint = ? AND release IS NOT NULL
    GROUP BY release
    ORDER BY first_seen ASC
  `).all(fp) as Record<string, unknown>[]

  if (!rows.length) {
    return undefined
  }

  // The issue's own first occurrence, against the oldest one still stored. If
  // the stored rows begin later than the issue does, the earliest release here
  // is the earliest *surviving* one and not necessarily where it started.
  const issue = await db.prepare(
    'SELECT first_seen FROM issues WHERE fingerprint = ?',
  ).get(fp) as { first_seen: number } | undefined

  const oldestStored = Number(rows[0]!.first_seen)

  const latest = rows.reduce((newest, row) =>
    Number(row.last_seen) > Number(newest.last_seen) ? row : newest, rows[0]!)

  return {
    first: String(rows[0]!.release),
    last: String(latest.release),
    count: rows.length,
    // A minute of slack: the issue row and the event row are written in the
    // same flush but their timestamps come from when each was captured.
    partial: issue ? oldestStored > Number(issue.first_seen) + 60_000 : false,
  }
}

/**
 * When one issue's stored occurrences happened, bucketed for a chart.
 *
 * Counts rows in `events`, which is *not* the same as the issue's `count`:
 * `maxEventsPerIssue` trims the table to the newest occurrences per issue, so
 * a busy issue keeps a window of recent history rather than all of it. The
 * shape is still the useful one — steady, spiking, or stopped — and the caller
 * is told how much it is drawn from so it can say when the two disagree.
 *
 * Bucketed in SQL rather than by the client, for the same reason the traffic
 * chart is: the rows are already grouped, and regrouping them against a second
 * grid built from a different clock puts them between columns.
 */
export async function issueTrend(
  db: Database,
  fp: string,
  filter?: MonitorFacetFilter,
  buckets = 32,
): Promise<MonitorIssueTrend> {
  const facets = facetClause(filter)

  const range = await db.prepare(`
    SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n
    FROM events WHERE fingerprint = ? ${facets.sql}
  `).get(fp, ...facets.params) as { first: number | null, last: number | null, n: number }

  const first = Number(range.first ?? 0)
  const last = Number(range.last ?? 0)
  const stored = Number(range.n ?? 0)

  if (!stored) {
    return { points: [], stored: 0, step: 0 }
  }

  // A span of zero — every occurrence inside one millisecond, or only one of
  // them — would divide by zero below. One bucket is the honest answer.
  const step = Math.max(1, Math.ceil((last - first + 1) / buckets))

  // `CAST(… AS INTEGER)` rather than relying on `/` to floor. The driver binds
  // these parameters as floats, so the division is a float division and every
  // row keeps its own fractional bucket — the grouping silently stops
  // happening and the chart draws one column per occurrence. Integer division
  // in the engine's own types is not something to assume through a parameter.
  const rows = await db.prepare(`
    SELECT CAST((ts - ?) / ? AS INTEGER) * ? + ? AS bucket, COUNT(*) AS n
    FROM events
    WHERE fingerprint = ? ${facets.sql}
    GROUP BY bucket
    ORDER BY bucket
  `).all(first, step, step, first, fp, ...facets.params) as { bucket: number, n: number }[]

  return {
    points: rows.map(row => ({ at: Number(row.bucket), count: Number(row.n) })),
    stored,
    step,
  }
}

/**
 * Releases, newest first, with what happened in each.
 *
 * The counts are the easy half. The column worth the screen is `newIssues`:
 * issues whose *first* occurrence anywhere carries this release. That is the
 * difference between "1.4.0 had 300 errors" — which mostly reflects how much
 * traffic it served — and "1.4.0 introduced 7 issues", which is a statement
 * about the deploy and the first thing anyone asks after one.
 */
export async function releases(db: Database, limit = 50): Promise<MonitorRelease[]> {
  const rows = await db.prepare(`
    WITH per_release AS (
      SELECT
        COALESCE(release, 'unknown') AS release,
        fingerprint,
        COUNT(*)                     AS events,
        COUNT(DISTINCT session)      AS sessions,
        MIN(ts)                      AS first_seen,
        MAX(ts)                      AS last_seen
      FROM events
      GROUP BY release, fingerprint
    ),
    -- Where each issue was seen first. An issue already present in 1.3.0 is
    -- not something 1.4.0 introduced, however often it happens there now.
    origin AS (
      SELECT fingerprint, COALESCE(release, 'unknown') AS release
      FROM (
        SELECT fingerprint, release, ROW_NUMBER() OVER (
          PARTITION BY fingerprint ORDER BY ts ASC
        ) AS rn
        FROM events
      )
      WHERE rn = 1
    )
    SELECT
      p.release                       AS release,
      SUM(p.events)                   AS events,
      COUNT(DISTINCT p.fingerprint)   AS issues,
      SUM(p.sessions)                 AS sessions,
      MIN(p.first_seen)               AS first_seen,
      MAX(p.last_seen)                AS last_seen,
      COUNT(DISTINCT CASE WHEN o.release = p.release THEN p.fingerprint END) AS new_issues
    FROM per_release p
    LEFT JOIN origin o USING (fingerprint)
    GROUP BY p.release
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(limit) as Record<string, number | string>[]

  return rows.map(row => ({
    release: String(row.release),
    events: Number(row.events),
    issues: Number(row.issues),
    newIssues: Number(row.new_issues),
    sessions: Number(row.sessions),
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
  }))
}

/**
 * Traffic and failures per route.
 *
 * The overview shows the worst five; this is the whole table, which is what
 * you want when the question is "which endpoints are worth attention" rather
 * than "what is on fire right now". Routes with no failures are included —
 * a healthy high-traffic route is context for the ones that are not.
 */
export async function routes(db: Database, since: number, limit = 100): Promise<MonitorRouteStat[]> {
  const sinceBucket = bucketOf(since, BUCKET_MS)

  const rows = await db.prepare(`
    SELECT
      route,
      SUM(count)                                              AS total,
      COALESCE(SUM(CASE WHEN class = '5xx' THEN count END), 0) AS failed
    FROM request_stats
    WHERE bucket >= ?
    GROUP BY route
    ORDER BY failed DESC, total DESC
    LIMIT ?
  `).all(sinceBucket, limit) as Record<string, number | string>[]

  /**
   * Method and status class per route, in one pass rather than per row.
   *
   * Both are already stored and neither was ever shown, which left the table
   * unable to say whether a route's failures were 5xx or 4xx — the difference
   * between a fault and a caller sending nonsense.
   */
  const detail = await db.prepare(`
    SELECT route, method, class, SUM(count) AS count
    FROM request_stats
    WHERE bucket >= ?
    GROUP BY route, method, class
  `).all(sinceBucket) as Record<string, number | string>[]

  const methods = new Map<string, Map<string, number>>()
  const classes = new Map<string, Record<string, number>>()

  for (const row of detail) {
    const route = String(row.route)
    const count = Number(row.count)

    const perMethod = methods.get(route) ?? new Map<string, number>()
    perMethod.set(String(row.method), (perMethod.get(String(row.method)) ?? 0) + count)
    methods.set(route, perMethod)

    const perClass = classes.get(route) ?? {}
    perClass[String(row.class)] = (perClass[String(row.class)] ?? 0) + count
    classes.set(route, perClass)
  }

  return rows.map((row) => {
    const route = String(row.route)
    const total = Number(row.total)
    const failed = Number(row.failed)

    return {
      route,
      total,
      failed,
      rate: total ? failed / total : 0,
      methods: [...(methods.get(route) ?? new Map())]
        .sort((a, b) => b[1] - a[1])
        .map(([method]) => method),
      classes: classes.get(route) ?? {},
    }
  })
}

/**
 * The traffic screen, in one call.
 *
 * Assembled server-side for the same reason the overview is: totals and a
 * chart fetched separately can disagree, and on a monitoring screen a
 * disagreement costs more trust than the round trip saves.
 */
export async function traffic(db: Database, windowMs: number, now = Date.now()): Promise<MonitorTrafficStats> {
  const since = now - windowMs
  const sinceBucket = bucketOf(since, BUCKET_MS)

  const byClass = await db.prepare(`
    SELECT class, SUM(count) AS count
    FROM request_stats
    WHERE bucket >= ?
    GROUP BY class
  `).all(sinceBucket) as Record<string, number | string>[]

  const byMethod = await db.prepare(`
    SELECT method, SUM(count) AS count
    FROM request_stats
    WHERE bucket >= ?
    GROUP BY method
    ORDER BY count DESC
  `).all(sinceBucket) as Record<string, number | string>[]

  /**
   * Regrouped into chart-sized buckets rather than the minute they are stored
   * in.
   *
   * Counters are kept per minute, which over a day is 1440 columns — far more
   * than a chart can draw, and drawn raw it collapses into a few wide bars
   * wherever traffic was sparse. Bucketing to the same 48 columns the error
   * chart uses makes the two comparable, which is the point of showing them on
   * one screen.
   */
  const step = Math.max(BUCKET_MS, Math.floor(windowMs / 48 / BUCKET_MS) * BUCKET_MS)

  // `CAST(… AS INTEGER)`: `step` binds as a float, so `/` floored nothing and
  // the regrouping into 48 slots quietly did not happen — the query returned
  // one row per stored minute, whatever the window.
  const trend = await db.prepare(`
    SELECT
      CAST(bucket / ? AS INTEGER) * ?                          AS slot,
      SUM(count)                                              AS total,
      COALESCE(SUM(CASE WHEN class = '5xx' THEN count END), 0) AS failed
    FROM request_stats
    WHERE bucket >= ?
    -- Repeated rather than aliased: Postgres resolves GROUP BY before the
    -- select list, so an alias there is an unknown column.
    GROUP BY CAST(bucket / ? AS INTEGER) * ?
    ORDER BY slot
  `).all(step, step, sinceBucket, step, step) as Record<string, number>[]

  const classes: Record<string, number> = {}

  for (const row of byClass) {
    classes[String(row.class)] = Number(row.count)
  }

  const total = Object.values(classes).reduce((sum, count) => sum + count, 0)
  const failed = classes['5xx'] ?? 0

  return {
    total,
    failed,
    // Undefined rather than zero when nothing was counted: "no traffic" and
    // "no failures" are different answers.
    rate: total ? failed / total : undefined,
    classes,
    methods: byMethod.map(row => ({ method: String(row.method), count: Number(row.count) })),
    trend: trend.map(row => ({
      bucket: Number(row.slot),
      total: Number(row.total),
      failed: Number(row.failed),
    })),
    routes: await routes(db, since),
  }
}

/**
 * How many sessions saw an error, against how many were seen at all.
 *
 * "How many people did this affect" is a different question from "how many
 * errors happened", and only the first one tells you whether to wake somebody.
 * Sessions are per-tab and only exist for client events, so this describes the
 * browser side; server errors have no session by nature.
 */
export async function sessions(db: Database, since: number): Promise<MonitorSessionStats> {
  const totals = await db.prepare(`
    SELECT
      COUNT(DISTINCT session) AS affected,
      COUNT(*)                AS events
    FROM events
    WHERE ts >= ? AND session IS NOT NULL
  `).get(since) as Record<string, number>

  // The sessions hit hardest. A session with fifty errors is one person stuck
  // in a loop, and that is worth being able to see directly.
  const worst = await db.prepare(`
    SELECT
      session,
      COUNT(*)                     AS events,
      COUNT(DISTINCT fingerprint)  AS issues,
      MIN(ts)                      AS first_seen,
      MAX(ts)                      AS last_seen
    FROM events
    WHERE ts >= ? AND session IS NOT NULL
    GROUP BY session
    ORDER BY events DESC
    LIMIT 20
  `).all(since) as Record<string, number | string>[]

  return {
    affected: Number(totals.affected ?? 0),
    events: Number(totals.events ?? 0),
    worst: worst.map(row => ({
      session: String(row.session),
      events: Number(row.events),
      issues: Number(row.issues),
      firstSeen: Number(row.first_seen),
      lastSeen: Number(row.last_seen),
    })),
  }
}

/**
 * Everything the overview screen shows, in one call.
 *
 * Assembled here rather than from several endpoints so the numbers on the
 * screen all describe the same instant — totals and a chart fetched
 * separately can disagree, and a disagreement in a monitoring tool costs
 * more trust than it saves effort.
 */
export async function overview(db: Database, windowMs = 24 * 60 * 60 * 1_000, now = Date.now()): Promise<MonitorOverview> {
  const since = now - windowMs

  /**
   * The same instant, floored to a counter bucket.
   *
   * `request_stats.bucket` holds the *start* of each minute, so comparing it
   * against a raw timestamp excludes the bucket `since` falls inside — the one
   * partly within the window. Every rate on the overview was therefore divided
   * by a denominator missing up to a minute of traffic, while the errors in
   * that same minute were counted in full.
   */
  const sinceBucket = bucketOf(since, BUCKET_MS)

  const totals = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN side = 'server' THEN count END), 0) AS server,
      COALESCE(SUM(CASE WHEN side = 'client' THEN count END), 0) AS client,
      COUNT(*) AS issues,
      COALESCE(SUM(CASE WHEN resolved = 0 THEN 1 END), 0) AS unresolved
    FROM issues
    WHERE last_seen >= ?
  `).get(since) as Record<string, number>

  const requests = await db.prepare(`
    SELECT
      COALESCE(SUM(count), 0) AS total,
      COALESCE(SUM(CASE WHEN class = '5xx' THEN count END), 0) AS failed
    FROM request_stats
    WHERE bucket >= ?
  `).get(sinceBucket) as Record<string, number>

  // `CAST(… AS INTEGER)`: the driver binds `BUCKET_MS` as a float, so `/` was
  // a float division that floored nothing — every occurrence kept its own
  // millisecond and the "per minute" grouping never happened. The client's
  // `toColumns` re-bucketed the result onto its own grid, which is why the
  // chart still looked right while the query underneath did not.
  const trend = await db.prepare(`
    SELECT
      CAST(ts / ? AS INTEGER) * ? AS bucket,
      SUM(CASE WHEN i.side = 'server' THEN 1 ELSE 0 END) AS server,
      SUM(CASE WHEN i.side = 'client' THEN 1 ELSE 0 END) AS client
    FROM events e
    JOIN issues i USING (fingerprint)
    WHERE e.ts >= ?
    GROUP BY bucket
    ORDER BY bucket
  `).all(BUCKET_MS, BUCKET_MS, since) as Record<string, number>[]

  const topRoutes = await db.prepare(`
    SELECT
      route,
      SUM(count) AS total,
      COALESCE(SUM(CASE WHEN class = '5xx' THEN count END), 0) AS failed
    FROM request_stats
    WHERE bucket >= ?
    GROUP BY route
    -- Repeated rather than referring to the alias: Postgres resolves HAVING
    -- before the select list, so an alias there is an unknown column. ORDER BY
    -- does see aliases, in every engine, so that one stays short.
    HAVING COALESCE(SUM(CASE WHEN class = '5xx' THEN count END), 0) > 0
    ORDER BY failed DESC
    LIMIT 5
  `).all(sinceBucket) as Record<string, number | string>[]

  const top = await db.prepare(`
    SELECT * FROM issues WHERE last_seen >= ? ORDER BY count DESC LIMIT 1
  `).get(since) as Record<string, unknown> | undefined

  /**
   * How many distinct people the window touched.
   *
   * Only browser events carry a session — a server error belongs to a request,
   * not to a tab — so this describes the client side and says so on screen.
   */
  const affected = await db.prepare(`
    SELECT COUNT(DISTINCT session) AS sessions
    FROM events
    WHERE ts >= ? AND session IS NOT NULL
  `).get(since) as Record<string, number> | undefined

  /**
   * The newest release that introduced something.
   *
   * Reusing `releases()` rather than repeating its window function: the
   * definition of "introduced" is subtle enough that two copies of it would
   * drift, and this is the same question the releases table answers.
   */
  const deployed = (await releases(db, 20))
    .find(release => release.newIssues > 0 && release.release !== 'unknown')

  const recent = await db.prepare(`
    SELECT * FROM issues WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT 5
  `).all(since) as Record<string, unknown>[]

  const totalEvents = Number(totals.server ?? 0) + Number(totals.client ?? 0)

  return {
    windowMs,
    serverErrors: Number(totals.server ?? 0),
    clientErrors: Number(totals.client ?? 0),
    totalEvents,
    issueCount: Number(totals.issues ?? 0),
    unresolvedCount: Number(totals.unresolved ?? 0),
    requestCount: Number(requests.total ?? 0),
    failedRequestCount: Number(requests.failed ?? 0),
    // Undefined rather than zero when nothing was counted: "no data" and
    // "no failures" are different answers, and showing 0% for the first
    // would be a lie.
    errorRate: requests.total ? Number(requests.failed) / Number(requests.total) : undefined,
    trend: trend.map(row => ({
      bucket: Number(row.bucket),
      server: Number(row.server),
      client: Number(row.client),
    })),
    topRoutes: topRoutes.map(row => ({
      route: String(row.route),
      total: Number(row.total),
      failed: Number(row.failed),
      rate: Number(row.total) ? Number(row.failed) / Number(row.total) : 0,
    })),
    topIssue: top
      ? { issue: toIssue(top), share: totalEvents ? Number(top.count) / totalEvents : 0 }
      : undefined,
    recent: recent.map(toIssue),
    affectedSessions: Number(affected?.sessions ?? 0),
    latestRelease: deployed
      ? {
          release: deployed.release,
          newIssues: deployed.newIssues,
          events: deployed.events,
          lastSeen: deployed.lastSeen,
        }
      : undefined,
  }
}

/**
 * Records the culprit a sourcemap resolved, replacing the built-file guess.
 *
 * Written rather than computed on every read because `culprit` is searchable:
 * a person who saw `server/api/throw.ts` in the list and types it into the box
 * must find the issue, and a value that exists only in the response would not
 * be in the column the `LIKE` runs against.
 *
 * Only ever called with a value the resolver produced, so there is no guard
 * against overwriting a good name with a worse one — the caller decides.
 */
export async function setCulprit(db: Database, fp: string, culprit: string): Promise<boolean> {
  const result = await db.prepare('UPDATE issues SET culprit = ? WHERE fingerprint = ?')
    .run(culprit, fp)

  return changesOf(result) > 0
}

export async function setResolved(db: Database, fp: string, resolved: boolean): Promise<boolean> {
  const result = await db.prepare('UPDATE issues SET resolved = ? WHERE fingerprint = ?')
    .run(resolved ? 1 : 0, fp)

  return changesOf(result) > 0
}

/**
 * Puts an issue aside, or brings it back.
 *
 * Kept apart from `setResolved` because the two say different things and both
 * are worth being able to say. "Resolved" claims a fix; "ignored" claims the
 * error is not the application's problem — an extension injecting into the
 * page, a crawler asking for a path that never existed. Folding them together
 * would mean marking noise as fixed, which quietly turns the resolved list
 * into a list of things that were never done.
 */
export async function setIgnored(db: Database, fp: string, ignored: boolean): Promise<boolean> {
  const result = await db.prepare('UPDATE issues SET ignored = ? WHERE fingerprint = ?')
    .run(ignored ? 1 : 0, fp)

  return changesOf(result) > 0
}

/**
 * Errors by hour of the day and day of the week.
 *
 * The one shape a line chart cannot show: a fault that only happens during the
 * nightly batch, or only at the Monday morning peak, is a flat unremarkable
 * line and an obvious bright cell. Reading it needs no explanation, which is
 * most of why it is worth the query.
 *
 * Bucketed in the server's local zone rather than UTC — "3am" means the hour
 * the people reading this were asleep, not an offset.
 */
export async function heatmap(db: Database, since: number): Promise<MonitorHeatCell[]> {
  const rows = await db
    .prepare('SELECT ts FROM events WHERE ts >= ?')
    .all(since) as { ts: number | string }[]

  const cells = new Map<string, number>()

  for (const row of rows) {
    const at = new Date(Number(row.ts))
    const key = `${at.getDay()}:${at.getHours()}`

    cells.set(key, (cells.get(key) ?? 0) + 1)
  }

  return [...cells].map(([key, count]) => {
    const [day, hour] = key.split(':')

    return { day: Number(day), hour: Number(hour), count }
  })
}

/**
 * What the traffic looked like, as facet shares.
 *
 * The denominator a breakdown needs. "90% of these errors are on iOS 16" is a
 * finding when iOS 16 is a tenth of the audience and a tautology when it is
 * nine tenths, and until this existed the comparison was against the facets of
 * other errors* — which answers a different question and flatters whichever
 * browser is noisiest.
 *
 * Shaped like `facetCounts` so the two are interchangeable at the call site.
 */
export async function trafficFacets(db: Database, windowMs: number, now = Date.now()): Promise<MonitorFacetCounts> {
  const since = bucketOf(now - windowMs, BUCKET_MS)

  const rows = await db.prepare(`
    SELECT facet, value, SUM(count) AS total
    FROM traffic_facets
    WHERE bucket >= ?
    GROUP BY facet, value
    ORDER BY total DESC
  `).all(since) as Record<string, unknown>[]

  const counts = {} as MonitorFacetCounts

  for (const name of FACET_NAMES) {
    counts[name] = { values: [], more: false }
  }

  // Totals per facet, so a share is against the traffic that reported that
  // dimension rather than against every row in the table.
  const totals = new Map<string, number>()

  for (const row of rows) {
    const facet = String(row.facet)
    totals.set(facet, (totals.get(facet) ?? 0) + Number(row.total))
  }

  for (const row of rows) {
    const facet = String(row.facet) as MonitorFacetName
    const group = counts[facet]

    if (!group) {
      continue
    }

    const total = totals.get(facet) ?? 0
    const count = Number(row.total)

    group.values.push({ value: String(row.value), count, share: total ? count / total : 0 })
  }

  return counts
}

/**
 * The delivery log, newest first.
 *
 * Suppressed and failed attempts included, because the question this table
 * answers is "why was I not told", and the answer is never in the successes.
 */
export async function deliveries(db: Database, limit = 100): Promise<MonitorDelivery[]> {
  // Joined to the issue for its message: a log row saying "New issue, sent" and
  // nothing else cannot be matched against what a reader remembers receiving,
  // which is exactly the comparison this screen is opened to make. `LEFT`, so a
  // row whose issue has since been evicted still lists what was sent.
  const rows = await db
    .prepare(`
      SELECT n.*, i.message AS issue_message, i.type AS issue_type
      FROM notifications n
      LEFT JOIN issues i ON i.fingerprint = n.fingerprint
      ORDER BY n.at DESC LIMIT ?
    `)
    .all(limit) as Record<string, unknown>[]

  return rows.map(row => ({
    id: Number(row.id),
    at: Number(row.at),
    channel: row.channel as string,
    reason: row.reason as MonitorDelivery['reason'],
    fingerprint: (row.fingerprint as string | null) ?? undefined,
    alerts: Number(row.alerts),
    status: row.status as MonitorDelivery['status'],
    detail: (row.detail as string | null) ?? undefined,
    issue: row.issue_message
      ? { type: String(row.issue_type), message: String(row.issue_message) }
      : undefined,
  }))
}
