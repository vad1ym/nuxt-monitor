import type { Database } from 'db0'
import type {
  MonitorDashboard,
  MonitorDashboardBreakdown,
  MonitorDashboardSlice,
  MonitorDeploy,
  MonitorFacetFilter,
  MonitorFacetName,
  MonitorRelease,
} from '../../types'
import { facetClause, facetColumn } from './facets'
import { BUCKET_MS } from './schema'
import { bucketOf, isFailedClass } from '../shared/route'
import * as queries from './queries'

/**
 * One screen's worth of numbers, in one round trip.
 *
 * The organising idea is that **no count here is shown alone**. Errors without
 * traffic is a number nobody can act on: four hundred errors is a catastrophe
 * on a quiet internal tool and a rounding error on a busy shop, and every
 * breakdown that ranks by error count alone ends up ranking browsers by
 * popularity. So each slice carries what it produced *and* how much of the
 * audience it was, and is ranked by the ratio.
 *
 * Assembled server-side rather than by the dashboard making six calls: the
 * numbers on one screen have to describe one instant, and six requests are six
 * chances for them to disagree about which.
 */

/** Rows per breakdown. Enough to see a pattern, few enough to read at a glance. */
const SLICES = 6

/**
 * Page views a slice needs before its ratio is believed.
 *
 * Without a floor a browser with three page views and one error reports a lift
 * of two hundred and tops every list. The floor is what keeps the ranking from
 * being a list of rare user agents.
 */
const MIN_TRAFFIC = 20

/** Chart columns. The same grid the other time charts use. */
const TREND_STEPS = 48

/**
 * Releases considered when looking for deploys inside the window.
 *
 * Ordered by `last_seen`, so this is "the most recently active releases" — far
 * more than could sit inside any window the dashboard offers, and cheap enough
 * that narrowing it further would be tuning for nothing.
 */
const RELEASES = 20

export interface DashboardOptions {
  windowMs: number
  now?: number
  filter?: MonitorFacetFilter
  /** Which dimensions to break down by. The screen decides; this obeys. */
  facets?: MonitorFacetName[]
}

const DEFAULT_FACETS: MonitorFacetName[] = ['kind', 'browser', 'os', 'deviceType', 'group', 'release']

export async function dashboard(db: Database, options: DashboardOptions): Promise<MonitorDashboard> {
  const { windowMs, now = Date.now(), filter, facets = DEFAULT_FACETS } = options
  const since = now - windowMs

  /**
   * The window immediately before this one, same length.
   *
   * Ends one millisecond before `since` rather than at it, so the two windows
   * touch without overlapping — a shared edge would count the events in that
   * instant on both sides and make a flat period look very slightly up.
   */
  const previousSince = since - windowMs

  const [totals, previous, trend, breakdowns, routes, overview, released, latency] = await Promise.all([
    totalsFor(db, since, now, filter),
    previousTotals(db, previousSince, since - 1, filter),
    trendFor(db, since, now, windowMs, filter),
    Promise.all(facets.map(facet => breakdownFor(db, facet, since, filter))),
    queries.routes(db, since, 8),
    // The three things this screen inherited from the overview it replaced:
    // what is loudest, what is newest, and whether the last deploy brought
    // anything with it. All three are already computed there.
    queries.overview(db, windowMs, now),
    // Reused rather than re-derived: "which release introduced this issue" is
    // a window function over every event, subtle enough that a second copy
    // would drift from the first.
    //
    // Deliberately *not* windowed, unlike the release line on the same screen.
    // `deploysIn` decides what counts as a deploy by comparing each release's
    // true `firstSeen` against the window edge, and a windowed query clamps
    // that value to the edge — so every release still running would report
    // first appearing just now and draw a marker it never earned.
    queries.releases(db, RELEASES),
    // How long requests took. The only figure on this screen that is not about
    // an error, and the one that catches a fault which never throws.
    queries.latency(db, since),
  ])

  return {
    windowMs,
    totals,
    previous,
    latency,
    trend,
    breakdowns,
    routes,
    topIssue: overview.topIssue,
    recent: overview.recent,
    latestRelease: overview.latestRelease,
    deploys: deploysIn(released, since, now),
  }
}

/**
 * The releases whose first appearance falls inside the window.
 *
 * A release that started before the window is not a deploy *in* it — drawing a
 * line at the left edge for every release the application has ever run would
 * mark the beginning of the chart rather than an event on it.
 *
 * `unknown` is dropped. It is what events carry when no release is configured
 * at all, so a line for it would say "this is when you started collecting",
 * which is not a deploy and not useful. An application with no `release` set
 * gets no markers, which is the honest outcome: the module was never told when
 * anything shipped.
 */
function deploysIn(released: MonitorRelease[], since: number, now: number): MonitorDeploy[] {
  return released
    .filter(entry => entry.release !== 'unknown' && entry.firstSeen >= since && entry.firstSeen <= now)
    .map(entry => ({
      release: entry.release,
      at: entry.firstSeen,
      newIssues: entry.newIssues,
      // Kept only to break ties below, then dropped.
      lastSeen: entry.lastSeen,
    }))
    // Oldest first. Two releases can share a `firstSeen` — a test writing both
    // in one millisecond, or a real deploy whose first events arrive together
    // — and a comparison on that alone leaves their order to however the rows
    // came back. Which release was still running later settles it.
    .sort((a, b) => a.at - b.at || a.lastSeen - b.lastSeen)
    .map(({ release, at, newIssues }) => ({ release, at, newIssues }))
}

/**
 * The previous window's tiles, or nothing when there was no previous window.
 *
 * The guard is the whole point of this function existing rather than a second
 * `totalsFor` call at the call site. A monitor installed this morning has an
 * empty window behind it, and a zero there is not a measurement — comparing
 * against it turns every figure into "up ∞%", which is the tool's loudest
 * possible statement made from no evidence whatsoever. It would also fire on
 * the very first day of every installation, so the first impression the
 * product gives would be a false alarm.
 *
 * "Any data at all" is deliberately a different question from "any events".
 * A perfectly healthy previous window has zero errors and plenty of requests,
 * and that zero is real: errors going 0 → 40 is exactly the comparison worth
 * drawing. Only the absence of *both* means the window was never observed.
 */
async function previousTotals(
  db: Database,
  since: number,
  until: number,
  filter: MonitorFacetFilter | undefined,
): Promise<MonitorDashboard['previous']> {
  const totals = await totalsFor(db, since, until, filter)
  const observed = totals.events > 0 || totals.requests > 0

  if (!observed) {
    return undefined
  }

  return {
    events: totals.events,
    issues: totals.issues,
    newIssues: totals.newIssues,
    requests: totals.requests,
    failed: totals.failed,
    errorRate: totals.errorRate,
    affectedSessions: totals.affectedSessions,
    sessions: totals.sessions,
  }
}

/**
 * The tiles, for one window.
 *
 * Bounded at both ends rather than open-ended at `now`, which it used to be.
 * The current window ends at the present moment so an upper bound changed
 * nothing there — but the same function now answers for the window *before*
 * this one, and without a ceiling that call would have counted everything
 * since, which is to say the current window twice over and a comparison of a
 * number against itself.
 */
async function totalsFor(
  db: Database,
  since: number,
  now: number,
  filter: MonitorFacetFilter | undefined,
): Promise<MonitorDashboard['totals']> {
  const scope = facetClause(filter)

  const events = await db.prepare(`
    SELECT COUNT(*) AS events,
           COUNT(DISTINCT fingerprint) AS issues,
           COUNT(DISTINCT session) AS sessions
    FROM events WHERE ts >= ? AND ts <= ? ${scope.sql}
  `).get(since, now, ...scope.params) as Record<string, unknown>

  const requests = await db.prepare(`
    SELECT class, SUM(count) AS total FROM request_stats
    WHERE bucket >= ? AND bucket <= ? GROUP BY class
  `).all(bucketOf(since, BUCKET_MS), now) as Record<string, unknown>[]

  let served = 0
  let failed = 0

  for (const row of requests) {
    const count = Number(row.total)

    served += count

    if (isFailedClass(String(row.class))) {
      failed += count
    }
  }

  // Issues that appeared inside the window, ignored ones excluded — the number
  // that says whether this window introduced anything, as opposed to how busy
  // it was.
  const appeared = await db.prepare(`
    SELECT COUNT(*) AS n FROM issues
    WHERE first_seen >= ? AND first_seen <= ? AND (ignored IS NULL OR ignored = 0)
  `).get(since, now) as { n: number }

  // What `affectedSessions` is out of. Without it that figure is a numerator
  // with no total, which is the one number on this screen nobody could read.
  const sessions = await queries.sessionTotal(db, since)

  return {
    requests: served,
    failed,
    // Undefined rather than zero: "no data" and "nothing failed" are opposite
    // statements, and 0% is the reassuring one.
    errorRate: served ? failed / served : undefined,
    events: Number(events.events ?? 0),
    issues: Number(events.issues ?? 0),
    newIssues: Number(appeared.n ?? 0),
    affectedSessions: Number(events.sessions ?? 0),
    sessions,
  }
}

/**
 * Requests and errors on one axis.
 *
 * Drawn together because the pair is the meaning: errors rising while traffic
 * rises is a busy afternoon, and errors rising while traffic is flat is a
 * deploy. Two charts side by side make the reader do that comparison by eye;
 * one chart makes it obvious.
 */
async function trendFor(
  db: Database,
  since: number,
  now: number,
  windowMs: number,
  filter: MonitorFacetFilter | undefined,
): Promise<MonitorDashboard['trend']> {
  const step = Math.max(BUCKET_MS, Math.floor(windowMs / TREND_STEPS / BUCKET_MS) * BUCKET_MS)
  const scope = facetClause(filter)

  const errors = await db.prepare(`
    SELECT ts FROM events WHERE ts >= ? ${scope.sql}
  `).all(since, ...scope.params) as { ts: number | string }[]

  const requests = await db.prepare(`
    SELECT bucket, class, SUM(count) AS total
    FROM request_stats WHERE bucket >= ? GROUP BY bucket, class
  `).all(bucketOf(since, BUCKET_MS)) as Record<string, unknown>[]

  const slots = new Map<number, { requests: number, failed: number, errors: number }>()

  const slotFor = (at: number): { requests: number, failed: number, errors: number } => {
    const key = Math.floor(at / step) * step
    const slot = slots.get(key) ?? { requests: 0, failed: 0, errors: 0 }

    slots.set(key, slot)

    return slot
  }

  for (const row of errors) {
    slotFor(Number(row.ts)).errors++
  }

  for (const row of requests) {
    const slot = slotFor(Number(row.bucket))
    const count = Number(row.total)

    slot.requests += count

    if (isFailedClass(String(row.class))) {
      slot.failed += count
    }
  }

  // Every column, including the empty ones: a gap drawn as a missing column
  // reads as a shorter window rather than as a quiet hour.
  const out: MonitorDashboard['trend'] = []

  for (let at = Math.floor(since / step) * step; at <= now; at += step) {
    const slot = slots.get(at) ?? { requests: 0, failed: 0, errors: 0 }

    out.push({ bucket: at, ...slot })
  }

  return out
}

/**
 * One dimension, with each slice's errors set against its share of traffic.
 *
 * Ranked by lift rather than by count. Ranking by count answers "which browser
 * is most popular", which the reader already knows and did not ask.
 */
async function breakdownFor(
  db: Database,
  facet: MonitorFacetName,
  since: number,
  filter: MonitorFacetFilter | undefined,
): Promise<MonitorDashboardBreakdown> {
  const column = facetColumn(facet)
  const scope = facetClause(filter)

  const rows = await db.prepare(`
    SELECT COALESCE(${column}, 'unknown') AS value, COUNT(*) AS n
    FROM events WHERE ts >= ? ${scope.sql}
    GROUP BY COALESCE(${column}, 'unknown')
    ORDER BY n DESC
  `).all(since, ...scope.params) as Record<string, unknown>[]

  const totalErrors = rows.reduce((sum, row) => sum + Number(row.n), 0)
  const audience = await trafficFor(db, facet, since)
  const totalTraffic = [...audience.values()].reduce((sum, count) => sum + count, 0)

  const slices: MonitorDashboardSlice[] = rows.map((row) => {
    const value = String(row.value)
    const errors = Number(row.n)
    const traffic = audience.get(value) ?? 0
    const errorShare = totalErrors ? errors / totalErrors : 0
    const trafficShare = totalTraffic ? traffic / totalTraffic : undefined

    return {
      value,
      errors,
      errorShare,
      traffic,
      trafficShare,
      // Only where the audience is big enough to mean something — see
      // MIN_TRAFFIC. A slice with three page views and one error would
      // otherwise report a lift of two hundred and top every list.
      lift: trafficShare && traffic >= MIN_TRAFFIC ? errorShare / trafficShare : undefined,
      // The absolute rate beside the relative one: `lift` says how unusual,
      // this says how bad.
      errorsPerView: traffic >= MIN_TRAFFIC ? errors / traffic : undefined,
    }
  })

  // Skewed slices first, then the plain big ones. A dimension with no audience
  // to compare against falls back to error share, which is the weaker question
  // but still the right ordering for it.
  const ranked = slices.sort((a, b) =>
    (b.lift ?? 0) - (a.lift ?? 0) || b.errors - a.errors,
  )

  const shown = ranked.slice(0, SLICES)

  return {
    facet,
    slices: shown,
    // The tail, stated rather than dropped: a breakdown that silently shows six
    // of forty values invites the reader to add them up and believe the total.
    otherErrors: totalErrors - shown.reduce((sum, slice) => sum + slice.errors, 0),
  }
}

/**
 * Page views per value of a dimension.
 *
 * Only the dimensions the traffic counters actually record. Route, release,
 * kind and group are properties of the request or of the code, not of the
 * visitor, so there is no audience to compare them against — those breakdowns
 * are ranked on error share alone and say so by carrying no lift.
 */
async function trafficFor(
  db: Database,
  facet: MonitorFacetName,
  since: number,
): Promise<Map<string, number>> {
  const counted = new Set<MonitorFacetName>(['browser', 'browserVersion', 'os', 'osVersion', 'deviceType'])

  if (!counted.has(facet)) {
    return new Map()
  }

  const rows = await db.prepare(`
    SELECT value, SUM(count) AS total FROM traffic_facets
    WHERE bucket >= ? AND facet = ? GROUP BY value
  `).all(bucketOf(since, BUCKET_MS), facet) as Record<string, unknown>[]

  return new Map(rows.map(row => [String(row.value), Number(row.total)]))
}
