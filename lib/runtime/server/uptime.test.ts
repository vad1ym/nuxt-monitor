import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import type { Database } from 'db0'
import { migrate } from './schema'
import { uptime } from './uptime'

/**
 * The day verdict.
 *
 * Written against the tables directly rather than through the store: the
 * question is about last Tuesday, and only fixed rows can ask it.
 */

const DAY = 24 * 60 * 60 * 1_000

let dir: string
let db: Database

function today(): number {
  const date = new Date()

  date.setHours(0, 0, 0, 0)

  return date.getTime()
}

let seq = 0

async function issue(at: number, extra: { group?: string, ignored?: boolean } = {}): Promise<void> {
  seq++

  await db.prepare(`
    INSERT INTO issues (fingerprint, type, message, side, count, first_seen, last_seen, ignored, group_name)
    VALUES (?, 'TypeError', 'boom', 'server', 1, ?, ?, ?, ?)
  `).run(`fp${seq}`, at, at, extra.ignored ? 1 : 0, extra.group ?? null)
}

async function serve(at: number, statusClass: string, count: number): Promise<void> {
  await db
    .prepare('INSERT INTO request_stats (bucket, route, method, class, count) VALUES (?, ?, ?, ?, ?)')
    .run(at, '/', 'GET', statusClass, count)
}

/** The verdict for a given day, which is what every test here asks about. */
async function stateOf(day: number, watched: string[] = []): Promise<string | undefined> {
  const result = await uptime(db, { days: 5, now: today() + 12 * 60 * 60_000, watched })

  return result.days.find(entry => entry.day === day)?.state
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-uptime-'))
  db = createDatabase(nodeSqlite({ path: join(dir, 'test.db') }))
  await migrate(db)
  seq = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a calm day', () => {
  it('is calm when traffic was served and nothing much appeared', async () => {
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 1_000)
    await issue(yesterday)

    expect(await stateOf(yesterday)).toBe('calm')
  })

  it('is unknown when nothing was recorded at all', async () => {
    // "No errors" and "no data" look identical in the database and mean
    // opposite things. Calling an unobserved day calm is the one lie this bar
    // must not tell.
    expect(await stateOf(today() - DAY)).toBe('unknown')
  })
})

describe('a notable day', () => {
  it('turns on a single new issue in a watched group', async () => {
    // Naming a group and asking to hear about it is exactly the statement that
    // one issue there is not ordinary.
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 1_000)
    await issue(yesterday, { group: 'payments' })

    expect(await stateOf(yesterday, ['payments'])).toBe('notable')
  })

  it('leaves an unwatched group alone', async () => {
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 1_000)
    await issue(yesterday, { group: 'admin' })

    expect(await stateOf(yesterday, ['payments'])).toBe('calm')
  })

  it('turns on a cluster of new issues, watched or not', async () => {
    // Usually one bad release.
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 1_000)

    for (let index = 0; index < 6; index++) {
      await issue(yesterday)
    }

    expect(await stateOf(yesterday)).toBe('notable')
  })
})

describe('a bad day', () => {
  it('turns on a great many new issues', async () => {
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 1_000)

    for (let index = 0; index < 30; index++) {
      await issue(yesterday)
    }

    expect(await stateOf(yesterday)).toBe('bad')
  })

  it('turns on a failure rate that means an outage', async () => {
    // One fingerprint can do this, and no count of new issues would catch it.
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 700)
    await serve(yesterday, '5xx', 300)
    await issue(yesterday)

    expect(await stateOf(yesterday)).toBe('bad')
  })

  it('does not count 404s and rate limits against the application', async () => {
    // Written under their own class precisely so a day of scanner traffic
    // cannot look like an outage.
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 500)
    await serve(yesterday, 'excused', 500)

    expect(await stateOf(yesterday)).toBe('calm')
  })

  it('counts the rest of the 4xx range as failures', async () => {
    // The other half of the same rule: a backend that answers 400 or 422 for
    // its own frontend's impossible request is failing, and a day of that is
    // not a calm day just because the status did not start with a 5.
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 700)
    await serve(yesterday, '4xx', 300)
    await issue(yesterday)

    expect(await stateOf(yesterday)).toBe('bad')
  })
})

describe('ignored issues', () => {
  it('never count, however many there are', async () => {
    // Ignoring an issue is the statement that it is not worth acting on. A bar
    // that reddens over dismissed noise is a bar people stop reading.
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 1_000)

    for (let index = 0; index < 30; index++) {
      await issue(yesterday, { ignored: true })
    }

    expect(await stateOf(yesterday)).toBe('calm')
  })

  it('not even in a watched group', async () => {
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 1_000)
    await issue(yesterday, { group: 'payments', ignored: true })

    expect(await stateOf(yesterday, ['payments'])).toBe('calm')
  })
})

describe('what counts as new', () => {
  it('is when an issue first appeared, not when it last happened', async () => {
    // An issue failing for a month is not news today, however often it fires.
    const old = today() - 4 * DAY

    await issue(old)
    await db.prepare('UPDATE issues SET last_seen = ?').run(today())
    await serve(today(), '2xx', 1_000)

    expect(await stateOf(today())).toBe('calm')
    expect(await stateOf(old)).toBe('calm')
  })
})

describe('the summary', () => {
  it('counts calm days out of the days there was data for', async () => {
    const yesterday = today() - DAY

    await serve(yesterday, '2xx', 1_000)
    await issue(yesterday)

    const result = await uptime(db, { days: 30, now: today() + 12 * 60 * 60_000 })

    // Not out of thirty: twenty-nine of those days have no data, and counting
    // them either way would make the number meaningless.
    expect(result.measuredDays).toBe(1)
    expect(result.calmDays).toBe(1)
  })

  it('reports the failure rate across the window', async () => {
    await serve(today(), '2xx', 900)
    await serve(today(), '5xx', 100)

    expect((await uptime(db, { days: 5 })).errorRate).toBeCloseTo(0.1)
  })
})
