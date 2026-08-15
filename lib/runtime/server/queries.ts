import type { Database } from 'db0'
import type {
  MonitorDelivery,
  MonitorDeploy,
  MonitorEvent,
  MonitorFacetCounts,
  MonitorFacetFilter,
  MonitorFacetName,
  MonitorHeatCell,
  MonitorInteraction,
  MonitorIssue,
  MonitorIssueTrend,
  MonitorLatency,
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
import { FAILED_SUM, bucketOf, isFailedClass, normalizeRoute } from '../shared/route'
import { percentile } from '../shared/latency'
import { BUCKET_MS } from './schema'
import { changesOf } from './db'

const HOUR_MS = 60 * 60 * 1_000

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
      + 'OR culprit LIKE ? ESCAPE \'\\\' OR route LIKE ? ESCAPE \'\\\' '
      // A correlation id, matched exactly rather than by substring.
      //
      // This is what somebody pastes when a user has given them a request id —
      // from a support ticket, a proxy log, a page that displayed one. The id
      // lives on the occurrence rather than the issue, so it needs the
      // subquery; it is an equality test because an id is either the one or it
      // is not, and a `LIKE` over an indexed column would also give up the
      // index for a search that runs on every keystroke.
      + 'OR EXISTS (SELECT 1 FROM events WHERE events.fingerprint = issues.fingerprint '
      + 'AND events.request_id = ?))',
    )

    // `escapeLike` keeps a literal `%` in a search term from matching
    // everything.
    const pattern = `%${escapeLike(filter.search)}%`
    params.push(pattern, pattern, pattern, pattern, filter.search)
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
 * Sessions that saw *any* error in the same period this issue spans.
 *
 * The denominator for "how much of the damage is this one". Deliberately not
 * "all sessions that visited": page views are counted as aggregates with no
 * session attached, so a share of total visitors is not computable from what
 * is stored — and inventing one by dividing by something else would put a
 * confident percentage on the screen that means nothing.
 *
 * What this answers instead is narrower and true: of the people having a bad
 * time, how many are having *this* bad time. 40 of 42 is one dominant fault;
 * 40 of 900 is a corner case with a loud count.
 *
 * Bounded to the issue's own span rather than a dashboard window, so the two
 * halves of the fraction cover the same stretch of time. A count from the last
 * 24 hours over a denominator from the last week is not a share of anything.
 */
export async function sessionShare(
  db: Database,
  fp: string,
  filter?: MonitorFacetFilter,
): Promise<{ affected: number, total: number } | undefined> {
  const facets = facetClause(filter)

  const span = await db.prepare(`
    SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(DISTINCT session) AS affected
    FROM events
    WHERE fingerprint = ? AND session IS NOT NULL ${facets.sql}
  `).get(fp, ...facets.params) as { first: number | null, last: number | null, affected: number }

  const affected = Number(span.affected ?? 0)

  // No sessions at all means a server-side issue, where the comparison is not
  // just unavailable but meaningless — a server error belongs to a request,
  // not to a person.
  if (!affected || span.first === null) {
    return undefined
  }

  const total = await db.prepare(`
    SELECT COUNT(DISTINCT session) AS n
    FROM events
    WHERE session IS NOT NULL AND ts >= ? AND ts <= ?
  `).get(Number(span.first), Number(span.last)) as { n: number }

  return { affected, total: Math.max(affected, Number(total.n)) }
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
  /**
   * Draw from here instead of from the first occurrence.
   *
   * Used to pull the axis back to the deploy that preceded the issue, so the
   * quiet stretch before the first error is on the chart. Without it the line
   * starts *at* the fault and the reader cannot see that anything changed —
   * every issue looks like it has always been happening at this rate.
   *
   * Ignored when it is not actually earlier, so a caller cannot accidentally
   * shorten the range or invert it.
   */
  from?: number,
): Promise<MonitorIssueTrend> {
  const facets = facetClause(filter)

  const range = await db.prepare(`
    SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n
    FROM events WHERE fingerprint = ? ${facets.sql}
  `).get(fp, ...facets.params) as { first: number | null, last: number | null, n: number }

  const earliest = Number(range.first ?? 0)
  const last = Number(range.last ?? 0)
  const stored = Number(range.n ?? 0)

  if (!stored) {
    return { points: [], stored: 0, step: 0 }
  }

  const first = from !== undefined && from < earliest ? from : earliest

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

  /**
   * Buckets with nothing in them, drawn as zero rather than left out.
   *
   * SQL returns no row for a bucket with no events, and the chart plots values
   * against labels by position — so a missing bucket does not leave a gap, it
   * closes one, and the line steps straight from the last quiet moment to the
   * first busy one as though they were adjacent. That is precisely the shape
   * this lead-in exists to show, and dropping the empties would draw it as a
   * flat line at full height: an issue that has always been happening.
   *
   * Only up to the last bucket that has data. Padding past it would invent a
   * quiet stretch after the most recent occurrence and make a live issue look
   * finished.
   */
  const counts = new Map(rows.map(row => [Number(row.bucket), Number(row.n)]))
  const lastBucket = Math.floor((last - first) / step) * step + first
  const points: { at: number, count: number }[] = []

  for (let at = first; at <= lastBucket; at += step) {
    points.push({ at, count: counts.get(at) ?? 0 })
  }

  return { points, stored, step }
}

/**
 * The deploys that landed while one issue was happening.
 *
 * "Did the last release fix this, or cause it?" is the question an issue page
 * exists to answer, and it is a question about shape either side of a moment.
 * A list of release names in the header cannot answer it — "introduced in
 * 1.8.2, last seen in 1.8.4" says an issue spans three releases, not that it
 * stopped dead the moment the third one went out.
 *
 * Bounded to the trend's own span rather than the dashboard window: this chart
 * is drawn from first to last occurrence of this issue, so a deploy outside
 * that has no x-position on it and would be drawn at an edge, marking the end
 * of the axis rather than an event on it.
 *
 * `unknown` is dropped, as everywhere else: it is what events carry when no
 * release is configured, and a line for it would mark when collection started.
 */
/**
 * The release that was already running when a moment happened.
 *
 * What an issue's chart needs to start from. A chart that begins at the first
 * occurrence begins after the cause: the deploy that introduced the fault is
 * off the left edge, and the one shape worth seeing — flat, then a release,
 * then errors — cannot be drawn, because the flat part is not on the canvas.
 *
 * Returns the release's own first appearance, not the moment asked about, so
 * the caller can extend the axis back to the deploy itself.
 */
export async function deployBefore(
  db: Database,
  moment: number,
): Promise<MonitorDeploy | undefined> {
  const row = await db.prepare(`
    SELECT release, MIN(ts) AS at
    FROM events
    WHERE release IS NOT NULL AND release != 'unknown'
    GROUP BY release
    HAVING at < ?
    ORDER BY at DESC
    LIMIT 1
  `).get(moment) as Record<string, number | string> | undefined

  return row
    ? { release: String(row.release), at: Number(row.at), newIssues: 0 }
    : undefined
}

export async function deploysBetween(
  db: Database,
  from: number,
  to: number,
): Promise<MonitorDeploy[]> {
  // Each release's first appearance *anywhere*, not within the span. A release
  // that started before this issue did was already running while it happened —
  // it is not a deploy that landed mid-issue, and drawing it would claim the
  // issue began at a moment that has nothing to do with it.
  //
  // `newIssues` counts what the release introduced across the application, not
  // within this issue, where it could only ever be 1 or 0. On this chart the
  // number answers the follow-up to seeing a line land on a spike: was this a
  // bad deploy generally, or did it break only the thing being looked at.
  const rows = await db.prepare(`
    WITH first_seen AS (
      SELECT release, MIN(ts) AS at
      FROM events
      WHERE release IS NOT NULL AND release != 'unknown'
      GROUP BY release
    ),
    origin AS (
      SELECT fingerprint, release
      FROM (
        SELECT fingerprint, release, ROW_NUMBER() OVER (
          PARTITION BY fingerprint ORDER BY ts ASC
        ) AS rn
        FROM events
      )
      WHERE rn = 1
    )
    SELECT
      f.release                        AS release,
      f.at                             AS at,
      COUNT(DISTINCT o.fingerprint)    AS new_issues
    FROM first_seen f
    LEFT JOIN origin o ON o.release = f.release
    WHERE f.at >= ? AND f.at <= ?
    GROUP BY f.release, f.at
    ORDER BY f.at
  `).all(from, to) as Record<string, number | string>[]

  return rows.map(row => ({
    release: String(row.release),
    at: Number(row.at),
    newIssues: Number(row.new_issues),
  }))
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
export async function releases(
  db: Database,
  limit = 50,
  since?: number,
): Promise<MonitorRelease[]> {
  /**
   * Activity is windowed; "introduced" is not.
   *
   * The two halves of this answer different questions and must not share a
   * window. How much a release is doing right now is only meaningful against
   * the period being looked at — beside a tile counting one hour, a lifetime
   * event count is a different measurement wearing the same clothes. Whether
   * a release *introduced* an issue is a fact about the deploy: an issue that
   * first appeared in 1.3.0 was not introduced by 1.4.0 because the reader
   * picked a one-hour window, and scoping `origin` would say exactly that —
   * every issue would look introduced by whatever shipped most recently.
   */
  const windowed = since !== undefined ? 'WHERE ts >= ?' : ''
  const bindings = since !== undefined ? [since, limit] : [limit]

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
      ${windowed}
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
  `).all(...bindings) as Record<string, number | string>[]

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
      ${FAILED_SUM} AS failed
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
      ${FAILED_SUM} AS failed
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
  const failed = Object.entries(classes)
    .reduce((sum, [name, count]) => isFailedClass(name) ? sum + count : sum, 0)

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
      ${FAILED_SUM} AS failed
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
      ${FAILED_SUM} AS failed
    FROM request_stats
    WHERE bucket >= ?
    GROUP BY route
    -- Repeated rather than referring to the alias: Postgres resolves HAVING
    -- before the select list, so an alias there is an unknown column. ORDER BY
    -- does see aliases, in every engine, so that one stays short.
    HAVING ${FAILED_SUM} > 0
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
   * The newest release that introduced something, within the window.
   *
   * Reusing `releases()` rather than repeating its window function: the
   * definition of "introduced" is subtle enough that two copies of it would
   * drift, and this is the same question the releases table answers.
   *
   * Windowed, because this line sits directly beneath tiles that count the
   * selected period. Unwindowed it reported a release's lifetime events and
   * last-seen next to figures for the last hour — two scales, one row, nothing
   * saying which was which. A release with nothing in the window now drops out
   * of the line entirely rather than being described by numbers from last week.
   */
  const deployed = (await releases(db, 20, since))
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

export async function setResolved(
  db: Database,
  fp: string,
  resolved: boolean,
  at = Date.now(),
): Promise<boolean> {
  // `resolved_at` is stamped on the way in and left alone on the way out, so
  // an issue that comes back still knows when the claim was made — that gap is
  // the whole content of a regression. Reopening by hand clears `regressed_at`
  // instead: somebody pressing Reopen is not reporting that it happened again,
  // they are withdrawing the claim that it was fixed.
  const result = resolved
    ? await db.prepare('UPDATE issues SET resolved = 1, resolved_at = ?, regressed_at = NULL WHERE fingerprint = ?')
        .run(at, fp)
    : await db.prepare('UPDATE issues SET resolved = 0, resolved_at = NULL, regressed_at = NULL WHERE fingerprint = ?')
        .run(fp)

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
 * Bucketed in **UTC** here and shifted to the reader's own zone in the browser.
 * Doing it in the server's zone was the obvious thing and the wrong one: "3am"
 * has to mean the hour the person looking at it was asleep, and a team spread
 * across two zones — or a server on UTC and nobody living there, which is the
 * normal deployment — saw a grid whose one conclusion was off by hours. The
 * hour of a *timestamp* is a question only the viewer can answer.
 *
 * A whole-hour bucket survives the shift intact because every zone this could
 * be read in is a whole or half hour from UTC; the half-hour ones land the
 * count in one adjacent cell, which is a smaller error than being wrong about
 * the whole grid.
 */
export async function heatmap(db: Database, since: number): Promise<MonitorHeatCell[]> {
  const rows = await db
    .prepare('SELECT ts FROM events WHERE ts >= ?')
    .all(since) as { ts: number | string }[]

  // Keyed by the absolute hour, not by weekday-and-hour. Collapsing to
  // "Tuesday 15:00" here would throw away the date, and the date is what the
  // browser needs to work out which weekday and which hour that instant falls
  // on where the reader is sitting.
  const cells = new Map<number, number>()

  for (const row of rows) {
    const hour = Math.floor(Number(row.ts) / HOUR_MS) * HOUR_MS

    cells.set(hour, (cells.get(hour) ?? 0) + 1)
  }

  return [...cells]
    .map(([at, count]) => ({ at, count }))
    .sort((a, b) => a.at - b.at)
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
 * How long requests took, as percentiles.
 *
 * p50 and p95 rather than a mean, which is the number this deliberately does
 * not report: latency distributions have long tails, so the mean sits in the
 * empty space between the fast majority and the slow minority, describing
 * nobody's experience, and it moves last exactly when the tail is what broke.
 * The p95 is the number people act on — one request in twenty was at least
 * this slow — and the p50 beside it is what says whether the whole thing
 * shifted or only the tail.
 *
 * Per route as well as overall, because the overall figure hides the finding:
 * one endpoint degrading is invisible in an average across all of them, and
 * "which endpoint" is the first question anybody asks next.
 */
export async function latency(
  db: Database,
  since: number,
  limit = 10,
): Promise<MonitorLatency> {
  const rows = await db.prepare(`
    SELECT route, le, SUM(count) AS count
    FROM request_latency
    WHERE bucket >= ?
    GROUP BY route, le
  `).all(bucketOf(since, BUCKET_MS)) as Record<string, unknown>[]

  const overall = new Map<string, number>()
  const byRoute = new Map<string, Map<string, number>>()

  for (const row of rows) {
    const route = String(row.route)
    const le = String(row.le)
    const count = Number(row.count)

    overall.set(le, (overall.get(le) ?? 0) + count)

    const bucket = byRoute.get(route) ?? new Map<string, number>()

    bucket.set(le, (bucket.get(le) ?? 0) + count)
    byRoute.set(route, bucket)
  }

  const routes = [...byRoute.entries()]
    .map(([route, counts]) => ({
      route,
      requests: [...counts.values()].reduce((sum, count) => sum + count, 0),
      p50: percentile(counts, 0.5),
      p95: percentile(counts, 0.95),
      p99: percentile(counts, 0.99),
    }))
    // Ranked by the tail rather than by volume: a busy fast endpoint is not
    // news, and a slow one is, however rarely it is called.
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
    .slice(0, limit)

  return {
    requests: [...overall.values()].reduce((sum, count) => sum + count, 0),
    p50: percentile(overall, 0.5),
    p95: percentile(overall, 0.95),
    p99: percentile(overall, 0.99),
    routes,
  }
}

/**
 * The other errors from the same request.
 *
 * The join the correlation id was captured for and could never do while it sat
 * inside a JSON blob. One request that fails usually produces two rows on two
 * different screens: the endpoint's 500 under server errors, and the browser's
 * `Cannot read properties of undefined` under client errors, thrown by the
 * component that received the failure. They are one incident, and reading them
 * as two is how somebody spends an afternoon debugging the symptom.
 *
 * Returns the *other* occurrences only — an issue is not related to itself,
 * and listing it would put the row somebody is already looking at inside its
 * own "related" panel.
 *
 * Bounded, because a request id can be adopted from an inbound header: a proxy
 * that sends a constant `x-request-id` would otherwise make this query return
 * the entire table.
 */
export async function relatedByRequest(
  db: Database,
  requestId: string,
  fingerprint: string,
  limit = 10,
): Promise<{ fingerprint: string, type: string, message: string, side: MonitorSide, at: number }[]> {
  const rows = await db.prepare(`
    SELECT e.fingerprint, e.ts, i.type, i.message, i.side
    FROM events e
    JOIN issues i USING (fingerprint)
    WHERE e.request_id = ? AND e.fingerprint <> ?
    GROUP BY e.fingerprint
    ORDER BY MIN(e.ts)
    LIMIT ?
  `).all(requestId, fingerprint, limit) as Record<string, unknown>[]

  return rows.map(row => ({
    fingerprint: String(row.fingerprint),
    type: String(row.type),
    message: String(row.message),
    side: row.side as MonitorSide,
    at: Number(row.ts),
  }))
}

/**
 * Sessions that visited in the window, whether or not anything broke for them.
 *
 * The denominator client-side error counts never had. "5 sessions saw an
 * error" is an outage out of 20 and a rounding error out of 200,000, and the
 * dashboard could only ever count the numerator: before this, a browser spoke
 * to the server only once something had already gone wrong.
 *
 * Read from `traffic_facets` under its own facet name rather than from a table
 * of its own, because it is exactly what that table is for — a count per
 * bucket with no identity attached. No session id is stored anywhere; the
 * de-duplication happens in memory before the counter is incremented.
 *
 * Returns 0 for a database that predates this, which reads correctly as "no
 * baseline" wherever a share is computed against it.
 */
export async function sessionTotal(db: Database, since: number): Promise<number> {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(count), 0) AS total
    FROM traffic_facets
    WHERE bucket >= ? AND facet = 'session'
  `).get(bucketOf(since, BUCKET_MS)) as { total: number | null }

  return Number(row?.total ?? 0)
}

/**
 * What people pressed, ranked, optionally within one page.
 *
 * The companion to the page ranking rather than a repeat of it. Page views say
 * where the traffic is; this says what it does when it gets there, and the two
 * together are what decide where a test is worth writing: a busy page whose
 * main action is rarely pressed is a different problem from one where every
 * visitor presses it, and neither number alone distinguishes them.
 *
 * `route` narrows it to a single page, which is how it is read when a page has
 * already been picked out of the ranking. Without it the counts are across the
 * application, where a label common to every page — "Submit", "Back" — sums
 * into the total it deserves rather than appearing once per route.
 *
 * `share` is against the presses in scope, not against page views: this
 * answers "of what is pressed here, how much is this", and comparing a press
 * count to a visit count would silently produce a rate above 1 for anything
 * people click twice.
 */
export async function interactions(
  db: Database,
  windowMs: number,
  options: { route?: string, limit?: number } = {},
  now = Date.now(),
): Promise<MonitorInteraction[]> {
  const since = bucketOf(now - windowMs, BUCKET_MS)
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200)

  const rows = options.route
    ? await db.prepare(`
        SELECT route, label, SUM(count) AS total
        FROM interactions
        WHERE bucket >= ? AND route = ?
        GROUP BY route, label
        ORDER BY total DESC
        LIMIT ?
      `).all(since, normalizeRoute(options.route), limit) as Record<string, unknown>[]
    : await db.prepare(`
        SELECT route, label, SUM(count) AS total
        FROM interactions
        WHERE bucket >= ?
        GROUP BY route, label
        ORDER BY total DESC
        LIMIT ?
      `).all(since, limit) as Record<string, unknown>[]

  // Against every press in scope, not only the ones that fit in `limit`: a
  // share taken over the returned page would sum to 1 no matter how much of
  // the tail was cut, so the top label of a long list would read as dominant
  // purely because the list was truncated.
  const scope = options.route
    ? await db.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM interactions WHERE bucket >= ? AND route = ?')
      .get(since, normalizeRoute(options.route)) as { total: number | null }
    : await db.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM interactions WHERE bucket >= ?')
      .get(since) as { total: number | null }

  const total = Number(scope?.total ?? 0)

  return rows.map(row => ({
    route: String(row.route),
    label: String(row.label),
    count: Number(row.total),
    share: total ? Number(row.total) / total : 0,
  }))
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
