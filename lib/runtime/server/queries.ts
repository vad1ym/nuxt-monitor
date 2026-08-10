import type { Database } from 'db0'
import type {
  MonitorEvent,
  MonitorFacetCounts,
  MonitorFacetFilter,
  MonitorIssue,
  MonitorOverview,
  MonitorRelease,
  MonitorRouteStat,
  MonitorSessionStats,
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

export async function listIssues(db: Database, filter: {
  side?: MonitorSide
  resolved?: boolean
  /** Free text, matched against message, type, location and route. */
  search?: string
  /** Exact error type, e.g. `TypeError`. */
  type?: string
  /** Keeps only issues with at least one occurrence matching every facet. */
  facets?: MonitorFacetFilter
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

  const rows = await db.prepare(`
    SELECT * FROM issues ${clause} ORDER BY last_seen DESC LIMIT ? OFFSET ?
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

  for (const name of FACET_NAMES) {
    const column = facetColumn(name)

    const rows = await db.prepare(`
      SELECT COALESCE(${column}, 'unknown') AS value, COUNT(*) AS n
      FROM events
      ${clause}
      GROUP BY value
      -- The value breaks ties, so a panel does not reshuffle equal rows
      -- between refreshes.
      ORDER BY n DESC, value ASC
      LIMIT 20
    `).all(...params, ...facets.params) as { value: string, n: number }[]

    const total = rows.reduce((sum, row) => sum + Number(row.n), 0)

    counts[name] = rows.map(row => ({
      value: String(row.value),
      count: Number(row.n),
      share: total ? Number(row.n) / total : 0,
    }))
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
  `).all(bucketOf(since, BUCKET_MS), limit) as Record<string, number | string>[]

  return rows.map((row) => {
    const total = Number(row.total)
    const failed = Number(row.failed)

    return {
      route: String(row.route),
      total,
      failed,
      rate: total ? failed / total : 0,
    }
  })
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

  const trend = await db.prepare(`
    SELECT
      (ts / ?) * ? AS bucket,
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
  }
}

export async function setResolved(db: Database, fp: string, resolved: boolean): Promise<boolean> {
  const result = await db.prepare('UPDATE issues SET resolved = ? WHERE fingerprint = ?')
    .run(resolved ? 1 : 0, fp)

  return changesOf(result) > 0
}
