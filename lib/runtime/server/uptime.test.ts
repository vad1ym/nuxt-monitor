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
 * The uptime verdict.
 *
 * Written against the tables directly rather than through the store, because
 * what is being tested is the reading — a day of heartbeats and a day of
 * counters have to be arranged by hand to ask about last Tuesday at all.
 */

const MINUTE = 60_000
const DAY = 24 * 60 * 60 * 1_000

let dir: string
let db: Database

/** Midnight today, which every day boundary is measured from. */
function today(): number {
  const date = new Date()

  date.setHours(0, 0, 0, 0)

  return date.getTime()
}

async function beat(from: number, minutes: number): Promise<void> {
  for (let index = 0; index < minutes; index++) {
    await db.prepare('INSERT INTO heartbeats (bucket) VALUES (?)').run(from + index * MINUTE)
  }
}

async function serve(at: number, statusClass: string, count: number): Promise<void> {
  await db
    .prepare('INSERT INTO request_stats (bucket, route, method, class, count) VALUES (?, ?, ?, ?, ?)')
    .run(at, '/', 'GET', statusClass, count)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-uptime-'))
  db = createDatabase(nodeSqlite({ path: join(dir, 'test.db') }))
  await migrate(db)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the distinction it exists for', () => {
  it('calls a quiet day quiet, not an outage', async () => {
    // Alive all through yesterday and nothing was asked of it. A weekend on an
    // internal tool is not a failure, and colouring it red teaches people to
    // ignore the bar.
    const yesterday = today() - DAY

    await beat(yesterday, 1_440)

    const result = await uptime(db, 3, today() + 12 * 60 * MINUTE)
    const day = result.days.find(entry => entry.day === yesterday)

    expect(day?.state).toBe('quiet')
  })

  it('calls a day with no heartbeat down, however few errors it holds', async () => {
    // The failure this whole feature is about: a process that is down produces
    // no errors, so measured on errors alone the worst outage renders green.
    const yesterday = today() - DAY

    // Alive the day before, then nothing.
    await beat(yesterday - DAY, 1_440)

    const result = await uptime(db, 3, today() + 12 * 60 * MINUTE)

    expect(result.days.find(entry => entry.day === yesterday)?.state).toBe('down')
  })
})

describe('states', () => {
  it('is up when it served traffic and little of it failed', async () => {
    const yesterday = today() - DAY

    await beat(yesterday, 1_440)
    await serve(yesterday + 60 * MINUTE, '2xx', 990)
    await serve(yesterday + 60 * MINUTE, '5xx', 10)

    const result = await uptime(db, 3, today() + 12 * 60 * MINUTE)
    const day = result.days.find(entry => entry.day === yesterday)

    expect(day?.state).toBe('up')
    expect(day?.rate).toBeCloseTo(0.01)
  })

  it('is degraded when too much of it failed', async () => {
    const yesterday = today() - DAY

    await beat(yesterday, 1_440)
    await serve(yesterday + 60 * MINUTE, '2xx', 80)
    await serve(yesterday + 60 * MINUTE, '5xx', 20)

    expect((await uptime(db, 3, today() + 12 * 60 * MINUTE))
      .days.find(entry => entry.day === yesterday)?.state).toBe('degraded')
  })

  it('does not count 4xx against the application', async () => {
    // A 404 says a client asked for something absent, which is not the
    // application being down.
    const yesterday = today() - DAY

    await beat(yesterday, 1_440)
    await serve(yesterday + 60 * MINUTE, '2xx', 50)
    await serve(yesterday + 60 * MINUTE, '4xx', 50)

    expect((await uptime(db, 3, today() + 12 * 60 * MINUTE))
      .days.find(entry => entry.day === yesterday)?.state).toBe('up')
  })

  it('leaves the days before collection unknown, not down', async () => {
    // A module installed on Tuesday must not open on a wall of red claiming
    // Monday was an outage.
    await beat(today(), 60)

    const result = await uptime(db, 5, today() + 60 * MINUTE)

    expect(result.days[0]?.state).toBe('unknown')
    expect(result.days.at(-1)?.state).not.toBe('unknown')
  })

  it('forgives a missed beat', async () => {
    // A flush can be late and a deploy restarts the process. One missing
    // minute is noise, and a bar that reddens on noise is a bar nobody trusts.
    const yesterday = today() - DAY

    await beat(yesterday, 700)
    await beat(yesterday + 701 * MINUTE, 739)

    expect((await uptime(db, 3, today() + 12 * 60 * MINUTE))
      .days.find(entry => entry.day === yesterday)?.state).toBe('quiet')
  })
})

describe('availability', () => {
  it('is measured from the first beat, not from the window', async () => {
    // Otherwise installing the module retroactively invents 89 days of outage.
    const now = today() + 100 * MINUTE

    await beat(today(), 100)

    expect((await uptime(db, 90, now)).availability).toBeCloseTo(1, 1)
  })

  it('falls when minutes are missing', async () => {
    const now = today() + 100 * MINUTE

    await beat(today(), 50)

    expect((await uptime(db, 90, now)).availability).toBeCloseTo(0.5, 1)
  })
})

describe('incidents', () => {
  it('reports a run of missing minutes with a beginning and an end', async () => {
    const start = today()

    await beat(start, 10)
    // Twenty minutes missing.
    await beat(start + 30 * MINUTE, 10)

    const [incident] = (await uptime(db, 3, start + 40 * MINUTE)).incidents

    expect(incident?.minutes).toBe(20)
    expect(incident?.from).toBe(start + 10 * MINUTE)
  })

  it('reports an outage that is still going', async () => {
    // The one most worth reporting, and the one with no later beat to close
    // the gap against.
    const start = today()

    await beat(start, 10)

    const [incident] = (await uptime(db, 3, start + 60 * MINUTE)).incidents

    expect(incident?.minutes).toBeGreaterThan(45)
  })

  it('says nothing when nothing was ever observed', async () => {
    const result = await uptime(db, 90)

    expect(result.incidents).toEqual([])
    expect(result.availability).toBe(0)
  })
})
