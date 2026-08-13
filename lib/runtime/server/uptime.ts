import type { Database } from 'db0'
import type { MonitorUptimeDay, MonitorUptimeSummary } from '../../types'

/**
 * Was the day calm?
 *
 * Not "was the process alive" — that is a different question, answered by
 * infrastructure that exists everywhere already, and answering it here would
 * mean writing a row a minute forever to detect what a restart policy handles.
 * What this asks is the question somebody actually opens a monitor for: *did
 * anything happen yesterday that I should have known about?*
 *
 * Three colours, because three is what a bar can say at a glance:
 *
 * - **calm** — nothing serious. New issues may have appeared; none of them was
 *   in a watched group and there were not many.
 * - **notable** — worth a look: a watched group failed, or enough new issues
 *   appeared at once to suggest a bad release.
 * - **bad** — either a great many new issues, or a failure rate high enough
 *   that the application was substantially not working.
 *
 * Ignored issues never count. Ignoring one is a statement that it is not worth
 * acting on, and a bar that turns amber over noise somebody already dismissed
 * is a bar that teaches people to stop reading it.
 */

const DAY_MS = 24 * 60 * 60 * 1_000

/**
 * New issues in a day before it stops being ordinary.
 *
 * A handful of new fingerprints is what a normal week of development looks
 * like. A dozen at once is usually one release, and that is worth seeing.
 */
const NOTABLE_NEW_ISSUES = 5
const BAD_NEW_ISSUES = 25

/**
 * Failure rate at which the day is bad whatever the issue counts say.
 *
 * One request in five failing is not a bug to triage, it is an outage — and it
 * can happen under a single fingerprint, which no count of new issues catches.
 */
const BAD_RATE = 0.2

export interface UptimeOptions {
  days?: number
  now?: number
  /** Groups configured with `notify: true`. A failure in one is never ordinary. */
  watched?: string[]
}

interface DayTally {
  newIssues: number
  watchedIssues: number
  requests: number
  failed: number
}

export async function uptime(db: Database, options: UptimeOptions = {}): Promise<MonitorUptimeSummary> {
  const { days = 90, now = Date.now(), watched = [] } = options
  const since = startOfDay(now) - (days - 1) * DAY_MS

  // `first_seen` rather than `last_seen`: an issue that has been failing for a
  // month is not news today, however often it happened. Ignored ones are left
  // out at the query rather than filtered later, so they cannot be counted by
  // accident anywhere below.
  const appeared = await db.prepare(`
    SELECT first_seen AS at, group_name
    FROM issues
    WHERE first_seen >= ? AND (ignored IS NULL OR ignored = 0)
  `).all(since) as Record<string, unknown>[]

  const traffic = await db.prepare(`
    SELECT bucket, class, SUM(count) AS total
    FROM request_stats WHERE bucket >= ?
    GROUP BY bucket, class
  `).all(since) as Record<string, unknown>[]

  const byDay = new Map<number, DayTally>()

  const tallyFor = (at: number): DayTally => {
    const day = startOfDay(at)
    const entry = byDay.get(day) ?? { newIssues: 0, watchedIssues: 0, requests: 0, failed: 0 }

    byDay.set(day, entry)

    return entry
  }

  for (const row of appeared) {
    const entry = tallyFor(Number(row.at))

    entry.newIssues++

    if (row.group_name && watched.includes(String(row.group_name))) {
      entry.watchedIssues++
    }
  }

  for (const row of traffic) {
    const entry = tallyFor(Number(row.bucket))
    const count = Number(row.total)

    entry.requests += count

    // 5xx only. A 404 is a client asking for something absent, which says
    // nothing about whether the application was working.
    if (row.class === '5xx') {
      entry.failed += count
    }
  }

  const result: MonitorUptimeDay[] = []

  for (let index = 0; index < days; index++) {
    const day = since + index * DAY_MS
    const entry = byDay.get(day) ?? { newIssues: 0, watchedIssues: 0, requests: 0, failed: 0 }
    const rate = entry.requests ? entry.failed / entry.requests : undefined

    result.push({
      day,
      newIssues: entry.newIssues,
      watchedIssues: entry.watchedIssues,
      requests: entry.requests,
      failed: entry.failed,
      rate,
      state: stateOf(entry, rate),
    })
  }

  const totals = result.reduce(
    (sum, day) => ({
      newIssues: sum.newIssues + day.newIssues,
      requests: sum.requests + day.requests,
      failed: sum.failed + day.failed,
    }),
    { newIssues: 0, requests: 0, failed: 0 },
  )

  const measured = result.filter(day => day.state !== 'unknown')

  return {
    days: result,
    newIssues: totals.newIssues,
    errorRate: totals.requests ? totals.failed / totals.requests : undefined,
    // "83 of the last 90 days were calm" is the sentence the bar draws, and the
    // one number worth putting beside it.
    calmDays: measured.filter(day => day.state === 'calm').length,
    measuredDays: measured.length,
  }
}

function stateOf(entry: DayTally, rate: number | undefined): MonitorUptimeDay['state'] {
  // Nothing recorded at all — before the module was installed, or while it was
  // not running. Grey rather than green: "no errors" and "no data" look
  // identical in the table and mean opposite things, and claiming a day was
  // calm because nobody was watching is the one lie this bar must not tell.
  if (entry.requests === 0 && entry.newIssues === 0) {
    return 'unknown'
  }

  if (entry.newIssues >= BAD_NEW_ISSUES || (rate !== undefined && rate >= BAD_RATE)) {
    return 'bad'
  }

  // A watched group is one somebody named and asked to hear about, so a single
  // new issue in it is never ordinary — that is what naming it meant.
  if (entry.watchedIssues > 0 || entry.newIssues >= NOTABLE_NEW_ISSUES) {
    return 'notable'
  }

  return 'calm'
}

function startOfDay(at: number): number {
  const date = new Date(at)

  date.setHours(0, 0, 0, 0)

  return date.getTime()
}
