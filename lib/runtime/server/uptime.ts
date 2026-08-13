import type { Database } from 'db0'
import type { MonitorUptime, MonitorUptimeDay } from '../../types'
import { BUCKET_MS } from './schema'

/**
 * Whether the application was up, and how badly it was failing when it was.
 *
 * Two sources, because neither answers the question alone. Request counters say
 * how much failed; heartbeats say whether there was anything running to fail.
 * Errors on their own cannot tell a quiet night from a dead process — the
 * process that is down produces no errors at all, so the worst outage there is
 * renders as a clean green bar. That failure is the reason this file reads two
 * tables instead of one.
 */

const MINUTE = BUCKET_MS
const DAY_MS = 24 * 60 * 60 * 1_000

/**
 * Failure rate at which a day stops counting as healthy.
 *
 * Deliberately not zero. Every application serving real traffic has some
 * failures, and a bar that goes amber on one 500 in a hundred thousand is a
 * bar nobody looks at twice.
 */
const DEGRADED_RATE = 0.05

/**
 * Minutes that may be missing before a day is called down.
 *
 * A flush can be late, a deploy restarts the process, and a machine can be
 * busy enough to skip a beat. One missing minute is noise; a run of them is an
 * outage — and `incidents` below reports the run, not the total.
 */
const TOLERATED_GAP = 2

export async function uptime(db: Database, days = 90, now = Date.now()): Promise<MonitorUptime> {
  const since = startOfDay(now) - (days - 1) * DAY_MS

  const beats = await db
    .prepare('SELECT bucket FROM heartbeats WHERE bucket >= ? ORDER BY bucket ASC')
    .all(since) as { bucket: number | string }[]

  const buckets = beats.map(row => Number(row.bucket))
  const alive = new Set(buckets)

  // Counted once, by day, rather than by walking 1440 minutes per day for 90
  // days on every request — the same answer for a fraction of the work.
  const aliveByDay = new Map<number, number>()

  for (const bucket of buckets) {
    const day = startOfDay(bucket)

    aliveByDay.set(day, (aliveByDay.get(day) ?? 0) + 1)
  }

  const traffic = await db.prepare(`
    SELECT bucket, class, SUM(count) AS total
    FROM request_stats WHERE bucket >= ?
    GROUP BY bucket, class
  `).all(since) as Record<string, unknown>[]

  /** Per day: requests served and requests that failed. */
  const served = new Map<number, { requests: number, failed: number }>()

  for (const row of traffic) {
    const day = startOfDay(Number(row.bucket))
    const entry = served.get(day) ?? { requests: 0, failed: 0 }
    const count = Number(row.total)

    entry.requests += count

    // 5xx only. A 4xx is the caller asking for something that is not there,
    // which says nothing about whether the application is up.
    if (row.class === '5xx') {
      entry.failed += count
    }

    served.set(day, entry)
  }

  // Nothing was observed before the first beat, and a module installed on
  // Tuesday must not report Monday as an outage.
  const observedFrom = buckets[0]

  const result: MonitorUptimeDay[] = []

  for (let index = 0; index < days; index++) {
    const day = since + index * DAY_MS
    const counts = served.get(day) ?? { requests: 0, failed: 0 }
    const aliveMinutes = aliveByDay.get(day) ?? 0
    const rate = counts.requests ? counts.failed / counts.requests : undefined

    result.push({
      day,
      requests: counts.requests,
      failed: counts.failed,
      rate,
      aliveMinutes,
      state: stateOf({ day, now, observedFrom, aliveMinutes, requests: counts.requests, rate }),
    })
  }

  const totals = result.reduce(
    (sum, day) => ({ requests: sum.requests + day.requests, failed: sum.failed + day.failed }),
    { requests: 0, failed: 0 },
  )

  return {
    days: result,
    availability: availabilityOf(alive, observedFrom, now),
    errorRate: totals.requests ? totals.failed / totals.requests : undefined,
    incidents: incidentsOf(buckets, observedFrom, now),
  }
}

/**
 * The day's verdict.
 *
 * Order matters: a day the process was missing for is `down` whatever its error
 * rate says, because the errors it did not record are the ones that would have
 * mattered most.
 */
function stateOf(input: {
  day: number
  now: number
  observedFrom: number | undefined
  aliveMinutes: number
  requests: number
  rate: number | undefined
}): MonitorUptimeDay['state'] {
  const { day, now, observedFrom, aliveMinutes, requests, rate } = input

  // Before anything was collected. Distinct from an outage, and drawn
  // differently: a fresh install should not open on a wall of red.
  if (observedFrom === undefined || day + DAY_MS <= observedFrom) {
    return 'unknown'
  }

  const expected = expectedMinutes(day, now, observedFrom)

  if (expected - aliveMinutes > TOLERATED_GAP) {
    return 'down'
  }

  if (rate !== undefined && rate >= DEGRADED_RATE) {
    return 'degraded'
  }

  // Alive, and nothing was asked of it. A weekend on an internal tool is not a
  // failure, and colouring it as one teaches people to ignore the bar.
  return requests === 0 ? 'quiet' : 'up'
}

/** Minutes of this day that could have been observed at all. */
function expectedMinutes(day: number, now: number, observedFrom: number): number {
  const from = Math.max(day, observedFrom)
  const to = Math.min(day + DAY_MS, now)

  return Math.max(0, Math.floor((to - from) / MINUTE))
}

/**
 * Share of the observed minutes the process was alive.
 *
 * Measured from the first beat rather than from the start of the window, so
 * installing the module does not retroactively invent an outage.
 */
function availabilityOf(alive: Set<number>, observedFrom: number | undefined, now: number): number {
  if (observedFrom === undefined) {
    return 0
  }

  const expected = Math.max(1, Math.floor((now - observedFrom) / MINUTE))

  return Math.min(1, alive.size / expected)
}

/**
 * Runs of missing minutes.
 *
 * A gap rather than a count: twenty scattered missed beats over a month is a
 * busy machine, and twenty consecutive ones is an outage with a beginning and
 * an end somebody can go and look up.
 */
function incidentsOf(
  buckets: number[],
  observedFrom: number | undefined,
  now: number,
): MonitorUptime['incidents'] {
  if (observedFrom === undefined) {
    return []
  }

  const incidents: MonitorUptime['incidents'] = []

  // The trailing edge is included: a process that stopped ten minutes ago has
  // no later beat to close the gap against, and that is the outage most worth
  // reporting.
  const marks = [...buckets, Math.floor(now / MINUTE) * MINUTE + MINUTE]

  for (let index = 1; index < marks.length; index++) {
    const gap = (marks[index]! - marks[index - 1]!) / MINUTE - 1

    if (gap > TOLERATED_GAP) {
      incidents.push({
        from: marks[index - 1]! + MINUTE,
        to: marks[index]!,
        minutes: gap,
      })
    }
  }

  return incidents.reverse()
}

function startOfDay(at: number): number {
  const date = new Date(at)

  date.setHours(0, 0, 0, 0)

  return date.getTime()
}
