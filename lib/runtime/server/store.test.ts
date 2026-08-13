import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MonitorEvent } from '../../types'
import { MonitorStore } from './store'

let dir: string
let store: MonitorStore

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    side: 'server',
    type: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at handler (/app/server/api/x.ts:3:9)',
    timestamp: Date.now(),
    ...overrides,
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-test-'))
  // Large flush size so tests drive flushing explicitly.
  store = await MonitorStore.open({
    dir,
    retentionDays: 14,
    maxEventsPerIssue: 5,
    flushSize: 1_000,
    flushInterval: 60_000,
  })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('overlapping flushes', () => {
  /**
   * Writing used to be synchronous, so a flush ran to completion before
   * anything else could start one. Now the interval timer, the size trigger
   * and an explicit call can all overlap, and two `BEGIN`s on one connection
   * do not nest.
   *
   * The SQLite connector happens to execute synchronously inside each
   * `await`, so these pass with or without the serialisation in `flush` —
   * measured, not assumed. They are kept as a guard for the connectors where
   * that is not true: on any real async driver an unserialised flush tears its
   * transaction, and these are what would catch it.
   */
  it('writes every event exactly once when callers overlap', async () => {
    // Distinct stacks, so each is its own issue and a lost write shows up as
    // a missing row rather than a smaller count.
    for (let i = 0; i < 50; i++) {
      store.capture(makeEvent({
        message: `event ${i}`,
        stack: `Error: x\n    at f (/app/e${i}.ts:1:1)`,
      }))
    }

    await Promise.all([store.flush(), store.flush(), store.flush()])

    expect((await store.listIssues()).total).toBe(50)
    expect((store as unknown as { buffer: unknown[] }).buffer.length).toBe(0)
  })

  it('leaves nothing buffered when a capture lands mid-flush', async () => {
    store.capture(makeEvent({ message: 'first', stack: 'Error: x\n    at f (/app/a.ts:1:1)' }))

    const racing = store.flush()
    store.capture(makeEvent({ message: 'second', stack: 'Error: x\n    at f (/app/b.ts:1:1)' }))

    await racing
    await store.flush()

    expect((await store.listIssues()).total).toBe(2)
  })
})

describe('capture and flush', () => {
  it('holds events in memory until flushed', async () => {
    store.capture(makeEvent())

    // listIssues flushes first, so read through the raw path instead: a fresh
    // store over the same file sees only what was committed.
    const other = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
    expect((await other.listIssues()).total).toBe(0)
    await other.close()
  })

  it('writes buffered events on flush', async () => {
    store.capture(makeEvent())
    await store.flush()

    const { issues, total } = await store.listIssues()
    expect(total).toBe(1)
    expect(issues[0]!.message).toBe('boom')
    expect(issues[0]!.count).toBe(1)
  })

  it('flushes early once the batch size is reached', async () => {
    const eager = await MonitorStore.open({
      dir: mkdtempSync(join(tmpdir(), 'monitor-eager-')),
      retentionDays: 14,
      maxEventsPerIssue: 100,
      flushSize: 3,
      flushInterval: 60_000,
    })

    eager.capture(makeEvent())
    eager.capture(makeEvent())
    expect((await eager.listIssues()).issues[0]?.count).toBe(2)

    await eager.close()
  })

  it('groups repeats into one issue and counts them', async () => {
    for (let i = 0; i < 5; i++) {
      store.capture(makeEvent({ message: `User ${i} not found` }))
    }
    await store.flush()

    const { issues, total } = await store.listIssues()
    expect(total).toBe(1)
    expect(issues[0]!.count).toBe(5)
  })

  it('keeps distinct faults apart', async () => {
    store.capture(makeEvent({ stack: 'E: a\n    at a (/app/a.ts:1:1)' }))
    store.capture(makeEvent({ stack: 'E: b\n    at b (/app/b.ts:1:1)' }))
    await store.flush()

    expect((await store.listIssues()).total).toBe(2)
  })

  it('tracks first and last seen across occurrences', async () => {
    store.capture(makeEvent({ timestamp: 1_000 }))
    store.capture(makeEvent({ timestamp: 5_000 }))
    await store.flush()

    const issue = (await store.listIssues()).issues[0]!
    expect(issue.firstSeen).toBe(1_000)
    expect(issue.lastSeen).toBe(5_000)
  })

  /**
   * These columns describe when the fault happened, not when the row arrived.
   *
   * Assigning the incoming value directly made them describe arrival order, so
   * a batch that lands out of sequence — a queued client flush, a backfill, a
   * skewed clock — pushed `last_seen` behind `first_seen`. Everything measured
   * from the span between them then reads as negative.
   */
  it('keeps the extremes when occurrences arrive out of order', async () => {
    store.capture(makeEvent({ timestamp: 5_000 }))
    await store.flush()
    store.capture(makeEvent({ timestamp: 1_000 }))
    await store.flush()

    const issue = (await store.listIssues()).issues[0]!

    expect(issue.firstSeen).toBe(1_000)
    expect(issue.lastSeen).toBe(5_000)
    expect(issue.lastSeen).toBeGreaterThanOrEqual(issue.firstSeen)
  })

  it('is a no-op when there is nothing buffered', async () => {
    await expect(store.flush()).resolves.toBeUndefined()
  })
})

describe('events', () => {
  it('round-trips context, breadcrumbs and tags', async () => {
    store.capture(makeEvent({
      context: { route: '/api/x', method: 'GET' },
      breadcrumbs: [{ type: 'navigation', timestamp: 1, message: '/' }],
      tags: ['request'],
    }))

    const fp = (await store.listIssues()).issues[0]!.fingerprint
    const [event] = await store.getEvents(fp)

    expect(event!.context).toEqual({ route: '/api/x', method: 'GET' })
    expect(event!.breadcrumbs?.[0]?.message).toBe('/')
    expect(event!.tags).toEqual(['request'])
  })

  it('caps stored events per issue, keeping the newest', async () => {
    for (let i = 0; i < 12; i++) {
      store.capture(makeEvent({ timestamp: 1_000 + i }))
    }
    await store.flush()

    const fp = (await store.listIssues()).issues[0]!.fingerprint
    const events = await store.getEvents(fp, 100)

    // maxEventsPerIssue is 5 for these tests.
    expect(events).toHaveLength(5)
    expect(events[0]!.timestamp).toBe(1_011)

    // The count still reflects every occurrence, not just what was kept.
    expect((await store.getIssue(fp))!.count).toBe(12)
  })
})

describe('filters', () => {
  beforeEach(async () => {
    store.capture(makeEvent({ side: 'server', stack: 'E\n    at s (/app/s.ts:1:1)' }))
    store.capture(makeEvent({ side: 'client', stack: 'E\n    at c (/app/c.ts:1:1)' }))
    await store.flush()
  })

  it('filters by side', async () => {
    expect((await store.listIssues({ side: 'client' })).total).toBe(1)
    expect((await store.listIssues({ side: 'client' })).issues[0]!.side).toBe('client')
  })

  it('filters by resolved state', async () => {
    const fp = (await store.listIssues({ side: 'server' })).issues[0]!.fingerprint
    await store.setResolved(fp, true)

    expect((await store.listIssues({ resolved: true })).total).toBe(1)
    expect((await store.listIssues({ resolved: false })).total).toBe(1)
  })

  it('paginates', async () => {
    const page = await store.listIssues({ limit: 1, offset: 0 })

    expect(page.issues).toHaveLength(1)
    // The total describes the whole filtered set, not the page.
    expect(page.total).toBe(2)
  })
})

describe('list metadata', () => {
  it('records where the error happened and which request caused it', async () => {
    store.capture(makeEvent({
      stack: 'TypeError: boom\n    at handler (/app/server/api/orders.ts:42:9)',
      context: { url: '/api/orders?page=2', method: 'POST', statusCode: 500 },
    }))

    const issue = (await store.listIssues()).issues[0]!

    // Enough to know where to look without opening the issue.
    expect(issue.culprit).toBe('api/orders.ts:42')
    expect(issue.route).toBe('/api/orders?page=2')
    expect(issue.method).toBe('POST')
    expect(issue.status).toBe(500)
  })

  it('skips library frames when naming the location', async () => {
    store.capture(makeEvent({
      stack: [
        'TypeError: boom',
        '    at run (/app/node_modules/vue/dist/runtime.js:100:5)',
        '    at setup (/app/pages/index.vue:12:3)',
      ].join('\n'),
    }))

    expect((await store.listIssues()).issues[0]!.culprit).toBe('pages/index.vue:12')
  })

  it('keeps the location from the most recent occurrence', async () => {
    const stack = (line: number): string =>
      `TypeError: boom\n    at setup (/app/pages/index.vue:${line}:3)`

    store.capture(makeEvent({ stack: stack(10) }))
    await store.flush()
    store.capture(makeEvent({ stack: stack(20) }))
    await store.flush()

    // Same issue — line numbers do not fork it — but the newer line is shown.
    const { issues, total } = await store.listIssues()
    expect(total).toBe(1)
    expect(issues[0]!.culprit).toBe('pages/index.vue:20')
  })

  it('leaves the fields empty when there is nothing to record', async () => {
    store.capture(makeEvent({ stack: undefined, context: undefined }))

    const issue = (await store.listIssues()).issues[0]!

    expect(issue.culprit).toBeUndefined()
    expect(issue.route).toBeUndefined()
  })
})

describe('search', () => {
  beforeEach(async () => {
    store.capture(makeEvent({
      message: 'Cannot read properties of null',
      type: 'TypeError',
      stack: 'TypeError: x\n    at setup (/app/pages/checkout.vue:12:3)',
      context: { url: '/checkout' },
    }))
    store.capture(makeEvent({
      message: 'Order could not be placed',
      type: 'ValidationError',
      stack: 'ValidationError: x\n    at handler (/app/server/api/orders.ts:5:1)',
      context: { url: '/api/orders' },
    }))
    await store.flush()
  })

  it('matches the message', async () => {
    expect((await store.listIssues({ search: 'could not be placed' })).total).toBe(1)
  })

  it('matches the file a person half-remembers', async () => {
    expect((await store.listIssues({ search: 'checkout.vue' })).issues[0]!.message)
      .toContain('Cannot read properties')
  })

  it('matches the route', async () => {
    expect((await store.listIssues({ search: '/api/orders' })).total).toBe(1)
  })

  it('is case-insensitive', async () => {
    expect((await store.listIssues({ search: 'ORDER' })).total).toBe(1)
  })

  it('treats wildcards as literal characters', async () => {
    // A bare `%` would otherwise match every row, which is not what a person
    // typing into a search box expects.
    expect((await store.listIssues({ search: '%' })).total).toBe(0)
    expect((await store.listIssues({ search: '_' })).total).toBe(0)
  })

  it('filters by exact type', async () => {
    expect((await store.listIssues({ type: 'ValidationError' })).total).toBe(1)
    expect((await store.listIssues({ type: 'TypeError' })).total).toBe(1)
    expect((await store.listIssues({ type: 'RangeError' })).total).toBe(0)
  })

  it('combines with the other filters', async () => {
    expect((await store.listIssues({ search: 'order', side: 'server' })).total).toBe(1)
    expect((await store.listIssues({ search: 'order', side: 'client' })).total).toBe(0)
  })
})

describe('request counters and overview', () => {
  it('reports no error rate when nothing was counted', async () => {
    store.capture(makeEvent())

    // "No data" and "no failures" are different answers; reporting 0% for the
    // first would be a lie the whole screen is built on.
    expect((await store.overview()).errorRate).toBeUndefined()
    expect((await store.overview()).requestCount).toBe(0)
  })

  it('computes the error rate from counted requests', async () => {
    for (let i = 0; i < 97; i++) {
      store.countRequest('/api/orders', 'GET', 200)
    }
    for (let i = 0; i < 3; i++) {
      store.countRequest('/api/orders', 'GET', 500)
    }

    const overview = await store.overview()

    expect(overview.requestCount).toBe(100)
    expect(overview.failedRequestCount).toBe(3)
    expect(overview.errorRate).toBeCloseTo(0.03)
  })

  it('does not count 4xx as a failed request', async () => {
    store.countRequest('/api/x', 'GET', 200)
    store.countRequest('/api/x', 'GET', 404)

    // A client asking for something absent is not the server failing.
    expect((await store.overview()).failedRequestCount).toBe(0)
    expect((await store.overview()).requestCount).toBe(2)
  })

  it('collapses ids so one endpoint is one counter row', async () => {
    for (let i = 0; i < 50; i++) {
      store.countRequest(`/users/${i}`, 'GET', 500)
    }

    const { topRoutes } = await store.overview()

    expect(topRoutes).toHaveLength(1)
    expect(topRoutes[0]!.route).toBe('/users/:id')
    expect(topRoutes[0]!.failed).toBe(50)
  })

  it('ranks routes by how many requests failed', async () => {
    store.countRequest('/api/quiet', 'GET', 500)
    for (let i = 0; i < 10; i++) {
      store.countRequest('/api/broken', 'GET', 500)
    }
    for (let i = 0; i < 90; i++) {
      store.countRequest('/api/broken', 'GET', 200)
    }

    const { topRoutes } = await store.overview()

    expect(topRoutes[0]!.route).toBe('/api/broken')
    expect(topRoutes[0]!.rate).toBeCloseTo(0.1)
  })

  it('omits routes that never failed', async () => {
    store.countRequest('/api/healthy', 'GET', 200)

    expect((await store.overview()).topRoutes).toHaveLength(0)
  })

  it('separates server and client error counts', async () => {
    store.capture(makeEvent({ side: 'server', stack: 'E\n    at s (/app/s.ts:1:1)' }))
    store.capture(makeEvent({ side: 'client', stack: 'E\n    at c (/app/c.ts:1:1)' }))
    store.capture(makeEvent({ side: 'client', stack: 'E\n    at c (/app/c.ts:1:1)' }))

    const overview = await store.overview()

    expect(overview.serverErrors).toBe(1)
    expect(overview.clientErrors).toBe(2)
    expect(overview.totalEvents).toBe(3)
    expect(overview.issueCount).toBe(2)
  })

  it('names the issue behind the most occurrences and its share', async () => {
    for (let i = 0; i < 8; i++) {
      store.capture(makeEvent({ message: 'the loud one', stack: 'E\n    at a (/app/a.ts:1:1)' }))
    }
    store.capture(makeEvent({ message: 'the quiet one', stack: 'E\n    at b (/app/b.ts:1:1)' }))
    store.capture(makeEvent({ message: 'another quiet one', stack: 'E\n    at c (/app/c.ts:1:1)' }))

    const { topIssue } = await store.overview()

    expect(topIssue?.issue.message).toBe('the loud one')
    expect(topIssue?.share).toBeCloseTo(0.8)
  })

  it('reports a trend bucketed over time', async () => {
    store.capture(makeEvent({ side: 'server' }))
    store.capture(makeEvent({ side: 'client', stack: 'E\n    at c (/app/c.ts:1:1)' }))

    const { trend } = await store.overview()

    expect(trend.length).toBeGreaterThan(0)
    expect(trend.reduce((sum, point) => sum + point.server + point.client, 0)).toBe(2)
  })

  /**
   * Bucketing has to actually group.
   *
   * The totals above hold whether or not it does, which is how a broken
   * `(ts / ?) * ?` survived: the driver bound the divisor as a float, so the
   * division floored nothing, every occurrence kept its own millisecond, and
   * the query returned one row per event. The chart looked right only because
   * the client re-bucketed the result onto its own grid.
   */
  it('groups occurrences within a bucket into one point', async () => {
    const now = Date.now()

    // Five occurrences seconds apart — comfortably inside one minute.
    for (let i = 0; i < 5; i++) {
      store.capture(makeEvent({ timestamp: now - i * 1_000 }))
    }

    const { trend } = await store.overview()

    expect(trend).toHaveLength(1)
    expect(trend[0]!.server).toBe(5)
    // And the bucket is the start of a minute, not a raw timestamp.
    expect(trend[0]!.bucket % 60_000).toBe(0)
  })

  it('lists the most recent issues', async () => {
    store.capture(makeEvent({ message: 'older', timestamp: Date.now() - 5_000, stack: 'E\n    at a (/a.ts:1:1)' }))
    store.capture(makeEvent({ message: 'newer', timestamp: Date.now(), stack: 'E\n    at b (/b.ts:1:1)' }))

    expect((await store.overview()).recent[0]!.message).toBe('newer')
  })

  it('excludes anything older than the window', async () => {
    const old = Date.now() - 48 * 60 * 60 * 1_000

    store.capture(makeEvent({ timestamp: old }))
    store.countRequest('/api/x', 'GET', 500, old)

    const overview = await store.overview(24 * 60 * 60 * 1_000)

    expect(overview.totalEvents).toBe(0)
    expect(overview.requestCount).toBe(0)
  })

  it('aggregates repeated requests rather than storing a row each', async () => {
    for (let i = 0; i < 1_000; i++) {
      store.countRequest('/api/orders', 'GET', 200)
    }

    expect((await store.overview()).requestCount).toBe(1_000)
  })
})

describe('migration', () => {
  it('adds new columns to a database created by an older version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'monitor-old-'))
    const db = new DatabaseSync(join(dir, 'monitor.db'))

    // The schema as it stood before `culprit` and friends existed.
    db.exec(`
      CREATE TABLE issues (
        fingerprint TEXT PRIMARY KEY, type TEXT NOT NULL, message TEXT NOT NULL,
        side TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL,
        ts INTEGER NOT NULL, stack TEXT, context TEXT, breadcrumbs TEXT, tags TEXT
      );
    `)
    db.close()

    const upgraded = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })

    // Writing must work rather than failing on the missing column.
    upgraded.capture(makeEvent())
    // Writing must work rather than failing on the missing column.
    await expect(upgraded.flush()).resolves.toBeUndefined()

    expect((await upgraded.listIssues()).total).toBe(1)

    await upgraded.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('resolve', () => {
  it('reopens a resolved issue when it happens again', async () => {
    store.capture(makeEvent())
    await store.flush()

    const fp = (await store.listIssues()).issues[0]!.fingerprint
    await store.setResolved(fp, true)
    expect((await store.getIssue(fp))!.resolved).toBe(true)

    store.capture(makeEvent())
    await store.flush()

    expect((await store.getIssue(fp))!.resolved).toBe(false)
  })

  it('reports when the fingerprint is unknown', async () => {
    expect(await store.setResolved('nope', true)).toBe(false)
  })
})

describe('purge', () => {
  it('drops events past the retention window and issues left empty', async () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1_000

    store.capture(makeEvent({ timestamp: old }))
    await store.flush()
    expect((await store.listIssues()).total).toBe(1)

    const result = await store.purge()

    expect(result.events).toBe(1)
    expect(result.issues).toBe(1)
    expect((await store.listIssues()).total).toBe(0)
  })

  it('keeps events inside the window', async () => {
    store.capture(makeEvent())
    await store.flush()

    expect((await store.purge()).events).toBe(0)
    expect((await store.listIssues()).total).toBe(1)
  })
})

/**
 * The ceiling that bounds bytes.
 *
 * Retention bounds by age and `maxIssues` by count; a burst of distinct
 * fingerprints with long stacks fills a disk days before either applies.
 */
describe('byte ceiling', () => {
  let bounded: MonitorStore

  /** Fills the database well past `maxBytes` with distinct issues. */
  async function fill(target: MonitorStore, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      target.capture(makeEvent({
        // Distinct messages mean distinct fingerprints, which is the axis that
        // actually runs away.
        message: `failed for widget ${i}`,
        stack: `Error: failed for widget ${i}\n${'    at handler (/app/server/api/x.ts:3:9)\n'.repeat(40)}`,
      }))
    }

    await target.flush()
  }

  afterEach(async () => {
    await bounded?.close()
  })

  it('evicts until the stored data fits', async () => {
    const CEILING = 2 * 1_024 * 1_024

    bounded = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100_000,
      maxBytes: CEILING,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    await fill(bounded, 4_000)
    expect(await bounded.bytes()).toBeGreaterThan(CEILING)

    await bounded.purge()

    expect(await bounded.bytes()).toBeLessThanOrEqual(CEILING)
    // And it stopped at the ceiling rather than emptying the table.
    expect((await bounded.listIssues()).total).toBeGreaterThan(0)
  })

  it('drops the oldest events, not an arbitrary selection', async () => {
    bounded = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100_000,
      maxBytes: 2 * 1_024 * 1_024,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    const now = Date.now()
    const COUNT = 4_000
    const stack = `Error: boom\n${'    at handler (/app/server/api/x.ts:3:9)\n'.repeat(40)}`

    // One fingerprint, so age is the only thing that can decide what survives.
    for (let i = 0; i < COUNT; i++) {
      bounded.capture(makeEvent({ timestamp: now - (COUNT - i) * 1_000, stack }))
    }

    await bounded.flush()
    await bounded.purge()

    const [issue] = (await bounded.listIssues()).issues
    expect(issue).toBeDefined()

    const events = await bounded.getEvents(issue!.fingerprint, 100)
    expect(events.length).toBeGreaterThan(0)

    // The survivors are a suffix of the range: the newest event is still here
    // and the oldest is gone.
    const oldest = now - COUNT * 1_000

    expect(events.some(event => event.timestamp === now - 1_000)).toBe(true)
    expect(events.every(event => event.timestamp > oldest)).toBe(true)
  })

  it('does nothing when the ceiling is disabled', async () => {
    bounded = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100,
      maxBytes: 0,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    await fill(bounded, 500)
    const before = (await bounded.listIssues()).total

    await bounded.purge()

    expect((await bounded.listIssues()).total).toBe(before)
  })

  /**
   * A ceiling below one page can never be met.
   *
   * Emptying the database to chase it would leave a dashboard showing no
   * errors, which reads as "nothing is wrong" rather than "the limit is too
   * low" — so the recent end survives and the condition is reported instead.
   */
  it('keeps recent events rather than emptying itself for an impossible ceiling', async () => {
    bounded = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100,
      maxBytes: 1,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    await fill(bounded, 2_000)

    await expect(bounded.purge()).resolves.toBeDefined()
    expect((await bounded.listIssues()).total).toBeGreaterThan(0)
    expect(await bounded.bytes()).toBeGreaterThan(1)
  })
})

describe('health', () => {
  it('reports what is stored and that collection is running', async () => {
    store.capture(makeEvent())
    await store.flush()

    const health = await store.health()

    expect(health.enabled).toBe(true)
    expect(health.issues).toBe(1)
    expect(health.events).toBe(1)
    expect(health.bytes).toBeGreaterThan(0)
    expect(health.dropped).toBe(0)
    expect(health.retryAfter).toBe(0)
    expect(health.overCeiling).toBe(false)
  })

  it('counts what is still buffered', async () => {
    store.capture(makeEvent())

    // Nothing written yet, so the buffer is the only place it exists.
    expect((await store.health()).pending).toBe(1)

    await store.flush()

    expect((await store.health()).pending).toBe(0)
  })

  /**
   * The distinction the endpoint exists for: a ceiling that cannot be met is
   * silently deleting today's errors, and the issue list alone cannot say so.
   */
  it('says when the byte ceiling cannot be met', async () => {
    const cramped = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100,
      maxBytes: 1,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    try {
      for (let i = 0; i < 2_000; i++) {
        cramped.capture(makeEvent({ message: `boom ${i}` }))
      }

      await cramped.flush()
      await cramped.purge()

      expect((await cramped.health()).overCeiling).toBe(true)
      expect((await cramped.health()).maxBytes).toBe(1)
    }
    finally {
      await cramped.close()
    }
  })

  /** And the flag is a condition, not a latch: a healthy store never sets it. */
  it('stays quiet while the ceiling is met', async () => {
    const roomy = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100,
      maxBytes: 64 * 1_024 * 1_024,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    try {
      roomy.capture(makeEvent())
      await roomy.flush()
      await roomy.purge()

      expect((await roomy.health()).overCeiling).toBe(false)
    }
    finally {
      await roomy.close()
    }
  })
})

describe('durability', () => {
  it('survives a reopen of the same file', async () => {
    store.capture(makeEvent())
    await store.close()

    const reopened = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })

    expect((await reopened.listIssues()).total).toBe(1)
    await reopened.close()

    // Keep afterEach's close() harmless.
    store = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
  })

  it('flushes pending events on close', async () => {
    store.capture(makeEvent())
    await store.close()

    const reopened = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
    expect((await reopened.listIssues()).total).toBe(1)
    await reopened.close()

    store = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
  })

  it('ignores captures after close instead of throwing', async () => {
    await store.close()

    expect(() => store.capture(makeEvent())).not.toThrow()

    store = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
  })
})

/**
 * The shape of an issue over time.
 *
 * Drawn from stored occurrences, which `maxEventsPerIssue` trims — so the
 * tests below care as much about what the query says it is drawn from as about
 * the buckets themselves.
 */
describe('issue trend', () => {
  it('buckets occurrences across the span they happened in', async () => {
    const hour = 60 * 60 * 1_000
    const base = 1_700_000_000_000

    // Three at the start, one an hour later.
    for (const at of [base, base + 1_000, base + 2_000, base + hour]) {
      store.capture(makeEvent({ timestamp: at }))
    }

    await store.flush()

    const fp = (await store.listIssues()).issues[0]!.fingerprint
    const trend = await store.issueTrend(fp)

    expect(trend.stored).toBe(4)
    expect(trend.points.reduce((sum, point) => sum + point.count, 0)).toBe(4)

    // The cluster and the straggler must not land in the same bucket, or the
    // chart is one bar and says nothing.
    expect(trend.points.length).toBeGreaterThan(1)
    expect(trend.points[0]!.count).toBe(3)
    expect(trend.points.at(-1)!.count).toBe(1)
  })

  it('reports how much it was drawn from when occurrences were trimmed', async () => {
    // This store keeps five per issue; ten arrive.
    for (let i = 0; i < 10; i++) {
      store.capture(makeEvent({ timestamp: 1_700_000_000_000 + i * 60_000 }))
    }

    await store.flush()

    const issue = (await store.listIssues()).issues[0]!
    const trend = await store.issueTrend(issue.fingerprint)

    // The card compares these two to decide whether to say "last 5 of 10".
    expect(issue.count).toBe(10)
    expect(trend.stored).toBe(5)
  })

  it('survives an issue whose occurrences share one instant', async () => {
    store.capture(makeEvent({ timestamp: 1_700_000_000_000 }))
    store.capture(makeEvent({ timestamp: 1_700_000_000_000 }))
    await store.flush()

    const fp = (await store.listIssues()).issues[0]!.fingerprint
    const trend = await store.issueTrend(fp)

    // A zero-length span would divide by zero when sizing buckets.
    expect(trend.step).toBeGreaterThan(0)
    expect(trend.points).toEqual([{ at: 1_700_000_000_000, count: 2 }])
  })

  it('has nothing to draw for an issue with no stored occurrences', async () => {
    expect(await store.issueTrend('missing')).toEqual({ points: [], stored: 0, step: 0 })
  })

  it('narrows to the filtered occurrences', async () => {
    store.capture(makeEvent({ timestamp: 1_700_000_000_000, facets: { browser: 'Chrome' } }))
    store.capture(makeEvent({ timestamp: 1_700_000_060_000, facets: { browser: 'Safari' } }))
    await store.flush()

    const fp = (await store.listIssues()).issues[0]!.fingerprint

    expect((await store.issueTrend(fp, { browser: ['Safari'] })).stored).toBe(1)
  })
})

describe('facets', () => {
  /** Distinct messages, so each lands in its own issue when needed. */
  function withFacets(facets: MonitorEvent['facets'], overrides: Partial<MonitorEvent> = {}): MonitorEvent {
    return makeEvent({ facets, ...overrides })
  }

  it('counts each dimension independently, most common first', async () => {
    store.capture(withFacets({ browser: 'Chrome', os: 'Windows' }))
    store.capture(withFacets({ browser: 'Chrome', os: 'macOS' }))
    store.capture(withFacets({ browser: 'Safari', os: 'iOS' }))
    await store.flush()

    const facets = await store.facetCounts()

    expect(facets.browser.values).toEqual([
      { value: 'Chrome', count: 2, share: 2 / 3 },
      { value: 'Safari', count: 1, share: 1 / 3 },
    ])
    // One event each, so their relative order is not defined — only the set is.
    expect(facets.os.values.map(row => row.value).sort()).toEqual(['Windows', 'iOS', 'macOS'].sort())
  })

  it('reports events without a facet as unknown rather than dropping them', async () => {
    store.capture(withFacets({ browser: 'Chrome' }))
    store.capture(makeEvent())
    await store.flush()

    expect((await store.facetCounts()).browser.values).toContainEqual({
      value: 'unknown',
      count: 1,
      share: 0.5,
    })
  })

  it('narrows the counts to one issue when scoped to a fingerprint', async () => {
    const first = store.capture(withFacets({ browser: 'Chrome' }))
    store.capture(withFacets({ browser: 'Safari' }, { message: 'different' }))
    await store.flush()

    const facets = await store.facetCounts({ fingerprint: first })

    expect(facets.browser.values).toEqual([{ value: 'Chrome', count: 1, share: 1 }])
  })

  it('applies a filter to the counts of the other dimensions', async () => {
    store.capture(withFacets({ browser: 'Chrome', os: 'Windows' }))
    store.capture(withFacets({ browser: 'Safari', os: 'iOS' }))
    await store.flush()

    const facets = await store.facetCounts({ filter: { browser: ['Safari'] } })

    expect(facets.os.values).toEqual([{ value: 'iOS', count: 1, share: 1 }])
  })

  it('records the route shape rather than the raw path', async () => {
    store.capture(makeEvent({ context: { url: '/users/1' } }))
    store.capture(makeEvent({ context: { url: '/users/2' } }))
    await store.flush()

    // Both are the same endpoint, so a breakdown must show one row.
    expect((await store.facetCounts()).route.values).toEqual([{ value: '/users/:id', count: 2, share: 1 }])
  })

  it('says when a dimension has more values than it returned', async () => {
    // Separate stacks so each lands in its own issue: this store keeps five
    // events per issue, and twenty-five under one fingerprint would be pruned
    // down to five before any of them could be counted.
    for (let i = 0; i < 25; i++) {
      store.capture(withFacets({ browser: `Browser ${i}` }, { stack: `E\n    at f (/app/b${i}.ts:1:1)` }))
    }

    await store.flush()

    const facets = await store.facetCounts({ limit: 20 })

    expect(facets.browser.values).toHaveLength(20)
    // Without this the panel shows twenty of twenty-five and reads as all.
    expect(facets.browser.more).toBe(true)

    // A dimension that fits says so, on the same response.
    expect(facets.deviceType.more).toBe(false)
  })

  it('shows the rest when asked for more', async () => {
    // Separate stacks so each lands in its own issue: this store keeps five
    // events per issue, and twenty-five under one fingerprint would be pruned
    // down to five before any of them could be counted.
    for (let i = 0; i < 25; i++) {
      store.capture(withFacets({ browser: `Browser ${i}` }, { stack: `E\n    at f (/app/b${i}.ts:1:1)` }))
    }

    await store.flush()

    const facets = await store.facetCounts({ limit: 40 })

    expect(facets.browser.values).toHaveLength(25)
    expect(facets.browser.more).toBe(false)
  })

  /**
   * The bars are a comparison, so the denominator has to be the thing being
   * compared against — every event in scope, not just the ones that fit.
   */
  it('measures share against all events, not only the returned values', async () => {
    // Ten events, each its own issue: this store keeps five events per issue,
    // so ten under one fingerprint would be pruned to five before they could
    // be counted. The stack is what separates them — a distinct message is not
    // enough, since the fingerprint normalises numbers out of it.
    store.capture(withFacets({ browser: 'Chrome' }, { stack: 'E\n    at f (/app/chrome.ts:1:1)' }))

    for (let i = 0; i < 9; i++) {
      store.capture(withFacets({ browser: `Other ${i}` }, { stack: `E\n    at f (/app/o${i}.ts:1:1)` }))
    }

    await store.flush()

    const facets = await store.facetCounts({ limit: 1 })

    // One row of ten events. Summing the returned rows instead would divide
    // one by one and report a browser used by a tenth of the traffic as all
    // of it.
    expect(facets.browser.values).toEqual([{ value: 'Chrome', count: 1, share: 0.1 }])
  })

  it('filters the occurrences of an issue by facet', async () => {
    const fp = store.capture(withFacets({ browser: 'Chrome' }))
    store.capture(withFacets({ browser: 'Safari' }))
    await store.flush()

    expect(await store.getEvents(fp)).toHaveLength(2)

    const filtered = await store.getEvents(fp, 20, { browser: ['Safari'] })

    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.facets?.browser).toBe('Safari')
  })

  /**
   * The number that separates a retry loop from an outage: many events across
   * few sessions is one person, few events across many sessions is everybody.
   */
  it('counts distinct sessions, not events', async () => {
    const fp = store.capture(withFacets({ session: 'a' }))
    store.capture(withFacets({ session: 'a' }))
    store.capture(withFacets({ session: 'b' }))
    await store.flush()

    expect((await store.getIssue(fp))!.count).toBe(3)
    expect(await store.sessionCount(fp)).toBe(2)
  })

  /**
   * `issue.count` counts every occurrence ever seen; the breakdown can only
   * describe the events still stored. The two must not be confused on screen.
   */
  it('counts stored events separately from the issue total', async () => {
    const fp = store.capture(withFacets({ browser: 'Chrome' }))

    // maxEventsPerIssue is 5 in these tests, so the cap trims the rest.
    for (let i = 0; i < 8; i++) {
      store.capture(withFacets({ browser: 'Chrome' }))
    }

    await store.flush()

    expect((await store.getIssue(fp))!.count).toBe(9)
    expect(await store.eventCount(fp)).toBe(5)
    expect(await store.eventCount(fp, { browser: ['Safari'] })).toBe(0)
  })

  it('reports no sessions for server errors, which carry none', async () => {
    const fp = store.capture(makeEvent())
    await store.flush()

    expect(await store.sessionCount(fp)).toBe(0)
  })

  /**
   * The facet columns were added after the first release, so a database
   * written by an older version must keep working rather than fail on read.
   */
  it('opens a database created before the facet columns existed', async () => {
    await store.close()

    const legacy = new DatabaseSync(join(dir, 'monitor.db'))
    legacy.exec('DROP TABLE events')
    legacy.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        ts INTEGER NOT NULL,
        stack TEXT, context TEXT, breadcrumbs TEXT, tags TEXT
      )
    `)
    legacy.prepare('INSERT INTO events (fingerprint, ts) VALUES (?, ?)').run('old', Date.now())
    legacy.close()

    store = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
    store.capture(withFacets({ browser: 'Chrome' }))
    await store.flush()

    // The pre-existing row has no browser and is reported as unknown.
    expect((await store.facetCounts()).browser.values).toContainEqual({
      value: 'unknown',
      count: 1,
      share: 0.5,
    })
  })
})

/**
 * Failure handling.
 *
 * Every case here was a silent data loss or a leak: the module either dropped
 * what it was given, or kept resources it had promised to release.
 */
describe('resilience', () => {
  /** Makes the next write fail, the way a locked or full database would. */
  /** The real `exec` for each store `breakWrites` has replaced. */
  const originalExec = new WeakMap<MonitorStore, unknown>()

  function breakWrites(target: MonitorStore): void {
    const db = (target as unknown as {
      db: { exec: (sql: string) => Promise<unknown> }
    }).db
    const real = db.exec.bind(db)

    originalExec.set(target, db.exec)

    // Rejecting rather than throwing: `exec` is asynchronous now, so a
    // synchronous throw would escape the `await` the store wraps it in and
    // never reach the catch that requeues the batch.
    db.exec = async (sql: string) => {
      if (sql === 'COMMIT') {
        throw new Error('database is locked')
      }

      return real(sql)
    }
  }

  function repairWrites(target: MonitorStore): void {
    // Restored explicitly rather than deleted: db0's `exec` is an own property
    // of the connection object, not something inherited, so deleting it left
    // the store with no `exec` at all.
    const holder = target as unknown as { db: { exec?: unknown } }
    const original = originalExec.get(target)

    if (original) {
      holder.db.exec = original
    }
  }

  it('keeps events when the write fails instead of dropping them', async () => {
    breakWrites(store)
    store.capture(makeEvent({ message: 'survives a locked database' }))
    await store.flush()

    // Nothing was written, but nothing was lost either.
    expect((await store.listIssues()).total).toBe(0)

    repairWrites(store)
    await store.flush()

    expect((await store.listIssues()).issues[0]?.message).toBe('survives a locked database')
  })

  it('keeps request counters when their write fails', async () => {
    breakWrites(store)
    store.countRequest('/checkout', 'GET', 500)
    await store.flush()

    repairWrites(store)
    await store.flush()

    expect((await store.overview()).requestCount).toBe(1)
  })

  /**
   * A failed batch stays buffered, so the buffer is still over the flush
   * threshold on the next event. Without a backoff every subsequent request
   * would drag a doomed synchronous transaction onto its own hot path.
   */
  it('stops flushing from the request path while writes are failing', async () => {
    const small = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 5,
      flushSize: 2,
      flushInterval: 60_000,
    })

    breakWrites(small)

    let flushes = 0
    const real = small.flush.bind(small)
    small.flush = () => { flushes++; return real() }

    // The first flush has to finish before the rest are captured: `capture`
    // no longer waits for the write, so the failure that sets the backoff
    // lands a tick later. Without settling it here the loop runs to
    // completion before the store knows writes are failing.
    small.capture(makeEvent({ message: 'event 0' }))
    small.capture(makeEvent({ message: 'event 1' }))
    await small.flush()

    for (let i = 2; i < 20; i++) {
      small.capture(makeEvent({ message: `event ${i}` }))
    }

    // One attempt from the request path, not one per event past the
    // threshold; the explicit flush above is the second.
    expect(flushes).toBe(2)

    repairWrites(small)
    await small.close()
  })

  /**
   * Given room beyond the default 5s, because it is genuinely slow rather than
   * stuck.
   *
   * The cap it proves is `MAX_PENDING_EVENTS`, a fixed 1_000, so the volume is
   * not a knob the test can turn down — it has to cross that line to prove
   * anything. Crossing it means 1_100 captures and two flush cycles whose
   * COMMIT is rejected, and a rejected flush requeues the whole batch. On this
   * machine that lands around 2.7s; CI is slower, and it timed out there while
   * passing everywhere else. A timeout tuned that close to the real duration
   * does not test the cap, it tests the runner's mood.
   */
  it('drops the oldest events rather than growing without bound', async () => {
    breakWrites(store)

    // Filled in two flushes rather than one per event: a failed flush requeues
    // the whole batch, so flushing 1_200 times reinserts an ever-growing buffer
    // and the test spends seconds proving something the cap decides in one go.
    for (let i = 0; i < 1_100; i++) {
      store.capture(makeEvent({ message: `event ${i}` }))
    }
    await store.flush()

    store.capture(makeEvent({ message: 'newest' }))
    await store.flush()

    const buffered = (store as unknown as { buffer: unknown[] }).buffer.length

    expect(buffered).toBeLessThanOrEqual(1_000)

    // The newest are the ones kept: during an ongoing failure the most recent
    // errors say more about what is happening than the oldest.
    const pending = (store as unknown as { buffer: { message: string }[] }).buffer

    expect(pending.at(-1)?.message).toBe('newest')
    expect(pending.at(0)?.message).not.toBe('event 0')

    repairWrites(store)
    await store.flush()

    expect((await store.listIssues()).total).toBeGreaterThan(0)
  }, 20_000)

  it('does not throw out of a read when trimming fails', async () => {
    store.capture(makeEvent())
    await store.flush()

    const holder = store as unknown as { trimEventsFor: () => Promise<void> }
    holder.trimEventsFor = () => Promise.reject(new Error('database is locked'))

    // The events are written; only the cap failed. A read must still answer.
    await expect(store.listIssues()).resolves.toBeDefined()
  })
})

describe('retention', () => {
  /**
   * `retentionDays` was plumbed through every layer and consulted by a method
   * with no caller outside the tests, so the documented guarantee about how
   * long data is kept was simply false.
   */
  it('applies retention on startup without being asked', async () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1_000

    store.capture(makeEvent({ timestamp: old }))
    await store.flush()
    expect((await store.listIssues()).total).toBe(1)
    await store.close()

    // A fresh process over the same database.
    store = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })

    expect((await store.listIssues()).total).toBe(0)
  })

  it('keeps events inside the window', async () => {
    store.capture(makeEvent({ timestamp: Date.now() - 24 * 60 * 60 * 1_000 }))
    await store.flush()
    await store.close()

    store = await MonitorStore.open({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })

    expect((await store.listIssues()).total).toBe(1)
  })
})

describe('per-occurrence message', () => {
  /**
   * Fingerprinting normalises ids out of the message, so occurrences with
   * different ids group together — and each still has its own text. Reading
   * the message off the issue showed the newest id on every row.
   */
  it('keeps the message each occurrence reported', async () => {
    const fp = store.capture(makeEvent({ message: 'User 111 not found' }))
    store.capture(makeEvent({ message: 'User 222 not found' }))
    await store.flush()

    const messages = (await store.getEvents(fp)).map(event => event.message)

    expect(messages).toContain('User 111 not found')
    expect(messages).toContain('User 222 not found')
  })
})

/**
 * The ceiling on distinct issues.
 *
 * Retention bounds by age and `maxEventsPerIssue` bounds events within an
 * issue; neither bounds how many issues exist. Measured before this existed:
 * 20k errors carrying dynamic text became 20k issues and 6.4 MB, growing with
 * traffic rather than with the size of the application.
 */
describe('issue ceiling', () => {
  async function makeStore(maxIssues: number): Promise<MonitorStore> {
    return await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 5,
      maxIssues,
      flushInterval: 60_000,
    })
  }

  it('evicts down to the ceiling when fingerprints run away', async () => {
    await store.close()
    store = await makeStore(10)

    // Each message is unique in a way normalisation cannot strip, so each
    // becomes its own issue.
    for (let i = 0; i < 50; i++) {
      store.capture(makeEvent({
        message: `failed for widget kx${i}zq`,
        stack: `Error: x\n    at f (/app/w${i}.ts:1:1)`,
      }))
    }
    await store.flush()
    await store.purge()

    expect((await store.listIssues({ limit: 200 })).total).toBe(10)
  })

  it('keeps what is recent and frequent, drops what is stale and rare', async () => {
    await store.close()
    store = await makeStore(2)

    const hour = 60 * 60 * 1_000
    const now = Date.now()

    // Stale and rare — the safest thing to lose.
    store.capture(makeEvent({
      message: 'ancient one-off',
      stack: 'Error: a\n    at a (/app/a.ts:1:1)',
      timestamp: now - 20 * hour,
    }))

    // Recent and frequent — what somebody is most likely looking for.
    for (let i = 0; i < 5; i++) {
      store.capture(makeEvent({
        message: 'happening right now',
        stack: 'Error: b\n    at b (/app/b.ts:1:1)',
        timestamp: now,
      }))
    }

    store.capture(makeEvent({
      message: 'recent one-off',
      stack: 'Error: c\n    at c (/app/c.ts:1:1)',
      timestamp: now - hour,
    }))

    await store.flush()
    await store.purge()

    const messages = (await store.listIssues()).issues.map(issue => issue.message)

    expect(messages).toContain('happening right now')
    expect(messages).not.toContain('ancient one-off')
  })

  it('leaves no orphaned events behind an evicted issue', async () => {
    await store.close()
    store = await makeStore(1)

    for (let i = 0; i < 5; i++) {
      store.capture(makeEvent({
        message: `distinct ${i}`,
        stack: `Error: x\n    at f (/app/d${i}.ts:1:1)`,
      }))
    }
    await store.flush()
    await store.purge()

    const orphans = await (store as unknown as {
      db: { prepare: (sql: string) => { get: () => Promise<{ n: number }> } }
    }).db.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE fingerprint NOT IN (SELECT fingerprint FROM issues)',
    ).get()

    expect(Number(orphans.n)).toBe(0)
  })

  it('does nothing while the database is under the ceiling', async () => {
    store.capture(makeEvent())
    await store.flush()

    expect((await store.purge()).issues).toBe(0)
    expect((await store.listIssues()).total).toBe(1)
  })
})

describe('counter bucket alignment', () => {
  /**
   * `request_stats.bucket` holds the start of each minute, so comparing it
   * against a raw timestamp dropped the bucket the window opens inside — the
   * denominator lost up to a minute of traffic while the errors in that same
   * minute were still counted, inflating every rate on the overview.
   */
  it('counts the bucket the window starts inside', async () => {
    const now = Date.now()
    // Half a minute in: floor(at / 60_000) is before `now - windowMs`.
    const at = now - 30_000

    store.countRequest('/api/x', 'GET', 200, at)
    await store.flush()

    expect((await store.overview(60_000, now)).requestCount).toBe(1)
  })

  it('still excludes traffic from before the window', async () => {
    const now = Date.now()

    store.countRequest('/api/x', 'GET', 200, now - 10 * 60_000)
    await store.flush()

    expect((await store.overview(60_000, now)).requestCount).toBe(0)
  })
})

describe('ignoring an issue', () => {
  /**
   * Distinct from resolving. Without this the only way to quiet a browser
   * extension's noise was to mark it fixed, which turns the resolved list into
   * a record of work that never happened.
   */
  async function capture(): Promise<string> {
    store.capture(makeEvent())
    await store.flush()

    return (await store.listIssues()).issues[0]!.fingerprint
  }

  it('hides an ignored issue from every other scope', async () => {
    const fp = await capture()

    expect(await store.setIgnored(fp, true)).toBe(true)

    // Not in the default list, nor in the unfiltered one.
    expect((await store.listIssues()).total).toBe(0)
    expect((await store.listIssues({ resolved: false })).total).toBe(0)
  })

  it('lists it again when asked for, and lets it come back', async () => {
    const fp = await capture()
    await store.setIgnored(fp, true)

    const ignored = await store.listIssues({ ignored: true })

    expect(ignored.total).toBe(1)
    expect(ignored.issues[0]!.ignored).toBe(true)

    await store.setIgnored(fp, false)

    expect((await store.listIssues()).total).toBe(1)
  })

  /** Ignoring is not resolving; neither should imply the other. */
  it('leaves the resolved flag alone', async () => {
    const fp = await capture()
    await store.setIgnored(fp, true)

    expect((await store.listIssues({ ignored: true })).issues[0]!.resolved).toBe(false)
  })
})

describe('sorting the issue list', () => {
  beforeEach(async () => {
    // Old but frequent.
    for (let i = 0; i < 5; i++) {
      store.capture(makeEvent({ message: 'frequent', timestamp: 1_000 + i }))
    }

    // New but rare — first *and* last seen after the other's last.
    store.capture(makeEvent({ message: 'recent', timestamp: 9_000 }))

    await store.flush()
  })

  it('orders by last seen by default', async () => {
    const { issues } = await store.listIssues()

    expect(issues[0]!.message).toBe('recent')
  })

  it('orders by occurrence count when asked', async () => {
    const { issues } = await store.listIssues({ sort: 'count' })

    expect(issues[0]!.message).toBe('frequent')
    expect(issues[0]!.count).toBe(5)
  })

  it('orders by first appearance, which is what "new" means', async () => {
    const { issues } = await store.listIssues({ sort: 'first-seen' })

    expect(issues[0]!.message).toBe('recent')
  })

  /** The clause reaches SQL, so an unknown name must fall back, not travel. */
  it('falls back to the default for an unknown sort', async () => {
    const { issues } = await store.listIssues({ sort: 'drop table' as never })

    expect(issues[0]!.message).toBe('recent')
  })
})

describe('traffic', () => {
  it('separates the caller\'s mistakes from the application\'s faults', async () => {
    store.countRequest('/api/x', 'GET', 200)
    store.countRequest('/api/x', 'GET', 500)
    store.countRequest('/api/y', 'POST', 404)
    await store.flush()

    const traffic = await store.traffic(60 * 60 * 1_000)

    expect(traffic.total).toBe(3)
    // 4xx is somebody else's problem and must not count as a failure.
    expect(traffic.failed).toBe(1)
    expect(traffic.classes).toMatchObject({ '2xx': 1, '4xx': 1, '5xx': 1 })
  })

  it('reports the methods a route was called with', async () => {
    store.countRequest('/api/x', 'GET', 200)
    store.countRequest('/api/x', 'POST', 200)
    await store.flush()

    const route = (await store.traffic(60 * 60 * 1_000)).routes
      .find(item => item.route === '/api/x')

    expect(route?.methods).toEqual(expect.arrayContaining(['GET', 'POST']))
    expect(route?.classes).toMatchObject({ '2xx': 2 })
  })

  it('leaves the rate undefined when nothing was counted', async () => {
    expect((await store.traffic(60 * 60 * 1_000)).rate).toBeUndefined()
  })
})

describe('which releases an issue spans', () => {
  it('names where it was introduced and where it was last seen', async () => {
    // The sentence somebody wants before reading a line of the stack: it says
    // whether a deploy caused this, and whether the one after it fixed it.
    const now = Date.now()

    store.capture(makeEvent({ timestamp: now - 2 * 60_000, facets: { release: '1.8.1' } }))
    store.capture(makeEvent({ timestamp: now - 60_000, facets: { release: '1.8.2' } }))
    store.capture(makeEvent({ timestamp: now, facets: { release: '1.8.3' } }))
    await store.flush()

    const fp = (await store.listIssues({})).issues[0]!.fingerprint
    const releases = await store.issueReleases(fp)

    expect(releases?.first).toBe('1.8.1')
    expect(releases?.last).toBe('1.8.3')
    expect(releases?.count).toBe(3)
    // Nothing was trimmed, so the first release really is where it began.
    expect(releases?.partial).toBe(false)
  })

  it('says nothing when no release was recorded', async () => {
    store.capture(makeEvent())
    await store.flush()

    const fp = (await store.listIssues({})).issues[0]!.fingerprint

    expect(await store.issueReleases(fp)).toBeUndefined()
  })
})
