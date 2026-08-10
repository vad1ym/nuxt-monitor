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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-test-'))
  // Large flush size so tests drive flushing explicitly.
  store = new MonitorStore({
    dir,
    retentionDays: 14,
    maxEventsPerIssue: 5,
    flushSize: 1_000,
    flushInterval: 60_000,
  })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('capture and flush', () => {
  it('holds events in memory until flushed', () => {
    store.capture(makeEvent())

    // listIssues flushes first, so read through the raw path instead: a fresh
    // store over the same file sees only what was committed.
    const other = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
    expect(other.listIssues().total).toBe(0)
    other.close()
  })

  it('writes buffered events on flush', () => {
    store.capture(makeEvent())
    store.flush()

    const { issues, total } = store.listIssues()
    expect(total).toBe(1)
    expect(issues[0]!.message).toBe('boom')
    expect(issues[0]!.count).toBe(1)
  })

  it('flushes early once the batch size is reached', () => {
    const eager = new MonitorStore({
      dir: mkdtempSync(join(tmpdir(), 'monitor-eager-')),
      retentionDays: 14,
      maxEventsPerIssue: 100,
      flushSize: 3,
      flushInterval: 60_000,
    })

    eager.capture(makeEvent())
    eager.capture(makeEvent())
    expect(eager.listIssues().issues[0]?.count).toBe(2)

    eager.close()
  })

  it('groups repeats into one issue and counts them', () => {
    for (let i = 0; i < 5; i++) {
      store.capture(makeEvent({ message: `User ${i} not found` }))
    }
    store.flush()

    const { issues, total } = store.listIssues()
    expect(total).toBe(1)
    expect(issues[0]!.count).toBe(5)
  })

  it('keeps distinct faults apart', () => {
    store.capture(makeEvent({ stack: 'E: a\n    at a (/app/a.ts:1:1)' }))
    store.capture(makeEvent({ stack: 'E: b\n    at b (/app/b.ts:1:1)' }))
    store.flush()

    expect(store.listIssues().total).toBe(2)
  })

  it('tracks first and last seen across occurrences', () => {
    store.capture(makeEvent({ timestamp: 1_000 }))
    store.capture(makeEvent({ timestamp: 5_000 }))
    store.flush()

    const issue = store.listIssues().issues[0]!
    expect(issue.firstSeen).toBe(1_000)
    expect(issue.lastSeen).toBe(5_000)
  })

  it('is a no-op when there is nothing buffered', () => {
    expect(() => store.flush()).not.toThrow()
  })
})

describe('events', () => {
  it('round-trips context, breadcrumbs and tags', () => {
    store.capture(makeEvent({
      context: { route: '/api/x', method: 'GET' },
      breadcrumbs: [{ type: 'navigation', timestamp: 1, message: '/' }],
      tags: ['request'],
    }))

    const fp = store.listIssues().issues[0]!.fingerprint
    const [event] = store.getEvents(fp)

    expect(event!.context).toEqual({ route: '/api/x', method: 'GET' })
    expect(event!.breadcrumbs?.[0]?.message).toBe('/')
    expect(event!.tags).toEqual(['request'])
  })

  it('caps stored events per issue, keeping the newest', () => {
    for (let i = 0; i < 12; i++) {
      store.capture(makeEvent({ timestamp: 1_000 + i }))
    }
    store.flush()

    const fp = store.listIssues().issues[0]!.fingerprint
    const events = store.getEvents(fp, 100)

    // maxEventsPerIssue is 5 for these tests.
    expect(events).toHaveLength(5)
    expect(events[0]!.timestamp).toBe(1_011)

    // The count still reflects every occurrence, not just what was kept.
    expect(store.getIssue(fp)!.count).toBe(12)
  })
})

describe('filters', () => {
  beforeEach(() => {
    store.capture(makeEvent({ side: 'server', stack: 'E\n    at s (/app/s.ts:1:1)' }))
    store.capture(makeEvent({ side: 'client', stack: 'E\n    at c (/app/c.ts:1:1)' }))
    store.flush()
  })

  it('filters by side', () => {
    expect(store.listIssues({ side: 'client' }).total).toBe(1)
    expect(store.listIssues({ side: 'client' }).issues[0]!.side).toBe('client')
  })

  it('filters by resolved state', () => {
    const fp = store.listIssues({ side: 'server' }).issues[0]!.fingerprint
    store.setResolved(fp, true)

    expect(store.listIssues({ resolved: true }).total).toBe(1)
    expect(store.listIssues({ resolved: false }).total).toBe(1)
  })

  it('paginates', () => {
    const page = store.listIssues({ limit: 1, offset: 0 })

    expect(page.issues).toHaveLength(1)
    // The total describes the whole filtered set, not the page.
    expect(page.total).toBe(2)
  })
})

describe('list metadata', () => {
  it('records where the error happened and which request caused it', () => {
    store.capture(makeEvent({
      stack: 'TypeError: boom\n    at handler (/app/server/api/orders.ts:42:9)',
      context: { url: '/api/orders?page=2', method: 'POST', statusCode: 500 },
    }))

    const issue = store.listIssues().issues[0]!

    // Enough to know where to look without opening the issue.
    expect(issue.culprit).toBe('api/orders.ts:42')
    expect(issue.route).toBe('/api/orders?page=2')
    expect(issue.method).toBe('POST')
    expect(issue.status).toBe(500)
  })

  it('skips library frames when naming the location', () => {
    store.capture(makeEvent({
      stack: [
        'TypeError: boom',
        '    at run (/app/node_modules/vue/dist/runtime.js:100:5)',
        '    at setup (/app/pages/index.vue:12:3)',
      ].join('\n'),
    }))

    expect(store.listIssues().issues[0]!.culprit).toBe('pages/index.vue:12')
  })

  it('keeps the location from the most recent occurrence', () => {
    const stack = (line: number): string =>
      `TypeError: boom\n    at setup (/app/pages/index.vue:${line}:3)`

    store.capture(makeEvent({ stack: stack(10) }))
    store.flush()
    store.capture(makeEvent({ stack: stack(20) }))
    store.flush()

    // Same issue — line numbers do not fork it — but the newer line is shown.
    const { issues, total } = store.listIssues()
    expect(total).toBe(1)
    expect(issues[0]!.culprit).toBe('pages/index.vue:20')
  })

  it('leaves the fields empty when there is nothing to record', () => {
    store.capture(makeEvent({ stack: undefined, context: undefined }))

    const issue = store.listIssues().issues[0]!

    expect(issue.culprit).toBeUndefined()
    expect(issue.route).toBeUndefined()
  })
})

describe('search', () => {
  beforeEach(() => {
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
    store.flush()
  })

  it('matches the message', () => {
    expect(store.listIssues({ search: 'could not be placed' }).total).toBe(1)
  })

  it('matches the file a person half-remembers', () => {
    expect(store.listIssues({ search: 'checkout.vue' }).issues[0]!.message)
      .toContain('Cannot read properties')
  })

  it('matches the route', () => {
    expect(store.listIssues({ search: '/api/orders' }).total).toBe(1)
  })

  it('is case-insensitive', () => {
    expect(store.listIssues({ search: 'ORDER' }).total).toBe(1)
  })

  it('treats wildcards as literal characters', () => {
    // A bare `%` would otherwise match every row, which is not what a person
    // typing into a search box expects.
    expect(store.listIssues({ search: '%' }).total).toBe(0)
    expect(store.listIssues({ search: '_' }).total).toBe(0)
  })

  it('filters by exact type', () => {
    expect(store.listIssues({ type: 'ValidationError' }).total).toBe(1)
    expect(store.listIssues({ type: 'TypeError' }).total).toBe(1)
    expect(store.listIssues({ type: 'RangeError' }).total).toBe(0)
  })

  it('combines with the other filters', () => {
    expect(store.listIssues({ search: 'order', side: 'server' }).total).toBe(1)
    expect(store.listIssues({ search: 'order', side: 'client' }).total).toBe(0)
  })
})

describe('request counters and overview', () => {
  it('reports no error rate when nothing was counted', () => {
    store.capture(makeEvent())

    // "No data" and "no failures" are different answers; reporting 0% for the
    // first would be a lie the whole screen is built on.
    expect(store.overview().errorRate).toBeUndefined()
    expect(store.overview().requestCount).toBe(0)
  })

  it('computes the error rate from counted requests', () => {
    for (let i = 0; i < 97; i++) {
      store.countRequest('/api/orders', 'GET', 200)
    }
    for (let i = 0; i < 3; i++) {
      store.countRequest('/api/orders', 'GET', 500)
    }

    const overview = store.overview()

    expect(overview.requestCount).toBe(100)
    expect(overview.failedRequestCount).toBe(3)
    expect(overview.errorRate).toBeCloseTo(0.03)
  })

  it('does not count 4xx as a failed request', () => {
    store.countRequest('/api/x', 'GET', 200)
    store.countRequest('/api/x', 'GET', 404)

    // A client asking for something absent is not the server failing.
    expect(store.overview().failedRequestCount).toBe(0)
    expect(store.overview().requestCount).toBe(2)
  })

  it('collapses ids so one endpoint is one counter row', () => {
    for (let i = 0; i < 50; i++) {
      store.countRequest(`/users/${i}`, 'GET', 500)
    }

    const { topRoutes } = store.overview()

    expect(topRoutes).toHaveLength(1)
    expect(topRoutes[0]!.route).toBe('/users/:id')
    expect(topRoutes[0]!.failed).toBe(50)
  })

  it('ranks routes by how many requests failed', () => {
    store.countRequest('/api/quiet', 'GET', 500)
    for (let i = 0; i < 10; i++) {
      store.countRequest('/api/broken', 'GET', 500)
    }
    for (let i = 0; i < 90; i++) {
      store.countRequest('/api/broken', 'GET', 200)
    }

    const { topRoutes } = store.overview()

    expect(topRoutes[0]!.route).toBe('/api/broken')
    expect(topRoutes[0]!.rate).toBeCloseTo(0.1)
  })

  it('omits routes that never failed', () => {
    store.countRequest('/api/healthy', 'GET', 200)

    expect(store.overview().topRoutes).toHaveLength(0)
  })

  it('separates server and client error counts', () => {
    store.capture(makeEvent({ side: 'server', stack: 'E\n    at s (/app/s.ts:1:1)' }))
    store.capture(makeEvent({ side: 'client', stack: 'E\n    at c (/app/c.ts:1:1)' }))
    store.capture(makeEvent({ side: 'client', stack: 'E\n    at c (/app/c.ts:1:1)' }))

    const overview = store.overview()

    expect(overview.serverErrors).toBe(1)
    expect(overview.clientErrors).toBe(2)
    expect(overview.totalEvents).toBe(3)
    expect(overview.issueCount).toBe(2)
  })

  it('names the issue behind the most occurrences and its share', () => {
    for (let i = 0; i < 8; i++) {
      store.capture(makeEvent({ message: 'the loud one', stack: 'E\n    at a (/app/a.ts:1:1)' }))
    }
    store.capture(makeEvent({ message: 'the quiet one', stack: 'E\n    at b (/app/b.ts:1:1)' }))
    store.capture(makeEvent({ message: 'another quiet one', stack: 'E\n    at c (/app/c.ts:1:1)' }))

    const { topIssue } = store.overview()

    expect(topIssue?.issue.message).toBe('the loud one')
    expect(topIssue?.share).toBeCloseTo(0.8)
  })

  it('reports a trend bucketed over time', () => {
    store.capture(makeEvent({ side: 'server' }))
    store.capture(makeEvent({ side: 'client', stack: 'E\n    at c (/app/c.ts:1:1)' }))

    const { trend } = store.overview()

    expect(trend.length).toBeGreaterThan(0)
    expect(trend.reduce((sum, point) => sum + point.server + point.client, 0)).toBe(2)
  })

  it('lists the most recent issues', () => {
    store.capture(makeEvent({ message: 'older', timestamp: Date.now() - 5_000, stack: 'E\n    at a (/a.ts:1:1)' }))
    store.capture(makeEvent({ message: 'newer', timestamp: Date.now(), stack: 'E\n    at b (/b.ts:1:1)' }))

    expect(store.overview().recent[0]!.message).toBe('newer')
  })

  it('excludes anything older than the window', () => {
    const old = Date.now() - 48 * 60 * 60 * 1_000

    store.capture(makeEvent({ timestamp: old }))
    store.countRequest('/api/x', 'GET', 500, old)

    const overview = store.overview(24 * 60 * 60 * 1_000)

    expect(overview.totalEvents).toBe(0)
    expect(overview.requestCount).toBe(0)
  })

  it('aggregates repeated requests rather than storing a row each', () => {
    for (let i = 0; i < 1_000; i++) {
      store.countRequest('/api/orders', 'GET', 200)
    }

    expect(store.overview().requestCount).toBe(1_000)
  })
})

describe('migration', () => {
  it('adds new columns to a database created by an older version', () => {
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

    const upgraded = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })

    // Writing must work rather than failing on the missing column.
    expect(() => {
      upgraded.capture(makeEvent())
      upgraded.flush()
    }).not.toThrow()

    expect(upgraded.listIssues().total).toBe(1)

    upgraded.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('resolve', () => {
  it('reopens a resolved issue when it happens again', () => {
    store.capture(makeEvent())
    store.flush()

    const fp = store.listIssues().issues[0]!.fingerprint
    store.setResolved(fp, true)
    expect(store.getIssue(fp)!.resolved).toBe(true)

    store.capture(makeEvent())
    store.flush()

    expect(store.getIssue(fp)!.resolved).toBe(false)
  })

  it('reports when the fingerprint is unknown', () => {
    expect(store.setResolved('nope', true)).toBe(false)
  })
})

describe('purge', () => {
  it('drops events past the retention window and issues left empty', () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1_000

    store.capture(makeEvent({ timestamp: old }))
    store.flush()
    expect(store.listIssues().total).toBe(1)

    const result = store.purge()

    expect(result.events).toBe(1)
    expect(result.issues).toBe(1)
    expect(store.listIssues().total).toBe(0)
  })

  it('keeps events inside the window', () => {
    store.capture(makeEvent())
    store.flush()

    expect(store.purge().events).toBe(0)
    expect(store.listIssues().total).toBe(1)
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
  function fill(target: MonitorStore, count: number): void {
    for (let i = 0; i < count; i++) {
      target.capture(makeEvent({
        // Distinct messages mean distinct fingerprints, which is the axis that
        // actually runs away.
        message: `failed for widget ${i}`,
        stack: `Error: failed for widget ${i}\n${'    at handler (/app/server/api/x.ts:3:9)\n'.repeat(40)}`,
      }))
    }

    target.flush()
  }

  afterEach(() => {
    bounded?.close()
  })

  it('evicts until the stored data fits', () => {
    const CEILING = 2 * 1_024 * 1_024

    bounded = new MonitorStore({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100_000,
      maxBytes: CEILING,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    fill(bounded, 4_000)
    expect(bounded.bytes()).toBeGreaterThan(CEILING)

    bounded.purge()

    expect(bounded.bytes()).toBeLessThanOrEqual(CEILING)
    // And it stopped at the ceiling rather than emptying the table.
    expect(bounded.listIssues().total).toBeGreaterThan(0)
  })

  it('drops the oldest events, not an arbitrary selection', () => {
    bounded = new MonitorStore({
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

    bounded.flush()
    bounded.purge()

    const [issue] = bounded.listIssues().issues
    expect(issue).toBeDefined()

    const events = bounded.getEvents(issue!.fingerprint, 100)
    expect(events.length).toBeGreaterThan(0)

    // The survivors are a suffix of the range: the newest event is still here
    // and the oldest is gone.
    const oldest = now - COUNT * 1_000

    expect(events.some(event => event.timestamp === now - 1_000)).toBe(true)
    expect(events.every(event => event.timestamp > oldest)).toBe(true)
  })

  it('does nothing when the ceiling is disabled', () => {
    bounded = new MonitorStore({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100,
      maxBytes: 0,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    fill(bounded, 500)
    const before = bounded.listIssues().total

    bounded.purge()

    expect(bounded.listIssues().total).toBe(before)
  })

  /**
   * A ceiling below one page can never be met.
   *
   * Emptying the database to chase it would leave a dashboard showing no
   * errors, which reads as "nothing is wrong" rather than "the limit is too
   * low" — so the recent end survives and the condition is reported instead.
   */
  it('keeps recent events rather than emptying itself for an impossible ceiling', () => {
    bounded = new MonitorStore({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100,
      maxBytes: 1,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    fill(bounded, 2_000)

    expect(() => bounded.purge()).not.toThrow()
    expect(bounded.listIssues().total).toBeGreaterThan(0)
    expect(bounded.bytes()).toBeGreaterThan(1)
  })
})

describe('health', () => {
  it('reports what is stored and that collection is running', () => {
    store.capture(makeEvent())
    store.flush()

    const health = store.health()

    expect(health.enabled).toBe(true)
    expect(health.issues).toBe(1)
    expect(health.events).toBe(1)
    expect(health.bytes).toBeGreaterThan(0)
    expect(health.dropped).toBe(0)
    expect(health.retryAfter).toBe(0)
    expect(health.overCeiling).toBe(false)
  })

  it('counts what is still buffered', () => {
    store.capture(makeEvent())

    // Nothing written yet, so the buffer is the only place it exists.
    expect(store.health().pending).toBe(1)

    store.flush()

    expect(store.health().pending).toBe(0)
  })

  /**
   * The distinction the endpoint exists for: a ceiling that cannot be met is
   * silently deleting today's errors, and the issue list alone cannot say so.
   */
  it('says when the byte ceiling cannot be met', () => {
    const cramped = new MonitorStore({
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

      cramped.flush()
      cramped.purge()

      expect(cramped.health().overCeiling).toBe(true)
      expect(cramped.health().maxBytes).toBe(1)
    }
    finally {
      cramped.close()
    }
  })

  /** And the flag is a condition, not a latch: a healthy store never sets it. */
  it('stays quiet while the ceiling is met', () => {
    const roomy = new MonitorStore({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100,
      maxBytes: 64 * 1_024 * 1_024,
      flushSize: 100_000,
      flushInterval: 60_000,
    })

    try {
      roomy.capture(makeEvent())
      roomy.flush()
      roomy.purge()

      expect(roomy.health().overCeiling).toBe(false)
    }
    finally {
      roomy.close()
    }
  })
})

describe('durability', () => {
  it('survives a reopen of the same file', () => {
    store.capture(makeEvent())
    store.close()

    const reopened = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })

    expect(reopened.listIssues().total).toBe(1)
    reopened.close()

    // Keep afterEach's close() harmless.
    store = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
  })

  it('flushes pending events on close', () => {
    store.capture(makeEvent())
    store.close()

    const reopened = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
    expect(reopened.listIssues().total).toBe(1)
    reopened.close()

    store = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
  })

  it('ignores captures after close instead of throwing', () => {
    store.close()

    expect(() => store.capture(makeEvent())).not.toThrow()

    store = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
  })
})

describe('facets', () => {
  /** Distinct messages, so each lands in its own issue when needed. */
  function withFacets(facets: MonitorEvent['facets'], overrides: Partial<MonitorEvent> = {}): MonitorEvent {
    return makeEvent({ facets, ...overrides })
  }

  it('counts each dimension independently, most common first', () => {
    store.capture(withFacets({ browser: 'Chrome', os: 'Windows' }))
    store.capture(withFacets({ browser: 'Chrome', os: 'macOS' }))
    store.capture(withFacets({ browser: 'Safari', os: 'iOS' }))
    store.flush()

    const facets = store.facetCounts()

    expect(facets.browser).toEqual([
      { value: 'Chrome', count: 2, share: 2 / 3 },
      { value: 'Safari', count: 1, share: 1 / 3 },
    ])
    // One event each, so their relative order is not defined — only the set is.
    expect(facets.os.map(row => row.value).sort()).toEqual(['Windows', 'iOS', 'macOS'].sort())
  })

  it('reports events without a facet as unknown rather than dropping them', () => {
    store.capture(withFacets({ browser: 'Chrome' }))
    store.capture(makeEvent())
    store.flush()

    expect(store.facetCounts().browser).toContainEqual({
      value: 'unknown',
      count: 1,
      share: 0.5,
    })
  })

  it('narrows the counts to one issue when scoped to a fingerprint', () => {
    const first = store.capture(withFacets({ browser: 'Chrome' }))
    store.capture(withFacets({ browser: 'Safari' }, { message: 'different' }))
    store.flush()

    const facets = store.facetCounts({ fingerprint: first })

    expect(facets.browser).toEqual([{ value: 'Chrome', count: 1, share: 1 }])
  })

  it('applies a filter to the counts of the other dimensions', () => {
    store.capture(withFacets({ browser: 'Chrome', os: 'Windows' }))
    store.capture(withFacets({ browser: 'Safari', os: 'iOS' }))
    store.flush()

    const facets = store.facetCounts({ filter: { browser: ['Safari'] } })

    expect(facets.os).toEqual([{ value: 'iOS', count: 1, share: 1 }])
  })

  it('records the route shape rather than the raw path', () => {
    store.capture(makeEvent({ context: { url: '/users/1' } }))
    store.capture(makeEvent({ context: { url: '/users/2' } }))
    store.flush()

    // Both are the same endpoint, so a breakdown must show one row.
    expect(store.facetCounts().route).toEqual([{ value: '/users/:id', count: 2, share: 1 }])
  })

  it('filters the occurrences of an issue by facet', () => {
    const fp = store.capture(withFacets({ browser: 'Chrome' }))
    store.capture(withFacets({ browser: 'Safari' }))
    store.flush()

    expect(store.getEvents(fp)).toHaveLength(2)

    const filtered = store.getEvents(fp, 20, { browser: ['Safari'] })

    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.facets?.browser).toBe('Safari')
  })

  /**
   * The number that separates a retry loop from an outage: many events across
   * few sessions is one person, few events across many sessions is everybody.
   */
  it('counts distinct sessions, not events', () => {
    const fp = store.capture(withFacets({ session: 'a' }))
    store.capture(withFacets({ session: 'a' }))
    store.capture(withFacets({ session: 'b' }))
    store.flush()

    expect(store.getIssue(fp)!.count).toBe(3)
    expect(store.sessionCount(fp)).toBe(2)
  })

  /**
   * `issue.count` counts every occurrence ever seen; the breakdown can only
   * describe the events still stored. The two must not be confused on screen.
   */
  it('counts stored events separately from the issue total', () => {
    const fp = store.capture(withFacets({ browser: 'Chrome' }))

    // maxEventsPerIssue is 5 in these tests, so the cap trims the rest.
    for (let i = 0; i < 8; i++) {
      store.capture(withFacets({ browser: 'Chrome' }))
    }

    store.flush()

    expect(store.getIssue(fp)!.count).toBe(9)
    expect(store.eventCount(fp)).toBe(5)
    expect(store.eventCount(fp, { browser: ['Safari'] })).toBe(0)
  })

  it('reports no sessions for server errors, which carry none', () => {
    const fp = store.capture(makeEvent())
    store.flush()

    expect(store.sessionCount(fp)).toBe(0)
  })

  /**
   * The facet columns were added after the first release, so a database
   * written by an older version must keep working rather than fail on read.
   */
  it('opens a database created before the facet columns existed', () => {
    store.close()

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

    store = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })
    store.capture(withFacets({ browser: 'Chrome' }))
    store.flush()

    // The pre-existing row has no browser and is reported as unknown.
    expect(store.facetCounts().browser).toContainEqual({
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
  function breakWrites(target: MonitorStore): void {
    const db = (target as unknown as { db: { exec: (sql: string) => void } }).db
    const real = db.exec.bind(db)

    db.exec = (sql: string) => {
      if (sql === 'COMMIT') {
        throw new Error('database is locked')
      }
      real(sql)
    }
  }

  function repairWrites(target: MonitorStore): void {
    const holder = target as unknown as { db: { exec: unknown } }
    delete (holder.db as { exec?: unknown }).exec
  }

  it('keeps events when the write fails instead of dropping them', () => {
    breakWrites(store)
    store.capture(makeEvent({ message: 'survives a locked database' }))
    store.flush()

    // Nothing was written, but nothing was lost either.
    expect(store.listIssues().total).toBe(0)

    repairWrites(store)
    store.flush()

    expect(store.listIssues().issues[0]?.message).toBe('survives a locked database')
  })

  it('keeps request counters when their write fails', () => {
    breakWrites(store)
    store.countRequest('/checkout', 'GET', 500)
    store.flush()

    repairWrites(store)
    store.flush()

    expect(store.overview().requestCount).toBe(1)
  })

  /**
   * A failed batch stays buffered, so the buffer is still over the flush
   * threshold on the next event. Without a backoff every subsequent request
   * would drag a doomed synchronous transaction onto its own hot path.
   */
  it('stops flushing from the request path while writes are failing', () => {
    const small = new MonitorStore({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 5,
      flushSize: 2,
      flushInterval: 60_000,
    })

    breakWrites(small)

    let flushes = 0
    const real = small.flush.bind(small)
    small.flush = () => { flushes++; real() }

    for (let i = 0; i < 20; i++) {
      small.capture(makeEvent({ message: `event ${i}` }))
    }

    // One attempt, not one per event past the threshold.
    expect(flushes).toBe(1)

    repairWrites(small)
    small.close()
  })

  // 1_200 captures, each with a forced flush against a failing write: slow
  // enough on a cold CI runner to outlast the default 5s.
  it('drops the oldest events rather than growing without bound', { timeout: 30_000 }, () => {
    breakWrites(store)

    for (let i = 0; i < 1_200; i++) {
      store.capture(makeEvent({ message: `event ${i}` }))
      // Force the attempt the backoff would otherwise suppress.
      store.flush()
    }

    const buffered = (store as unknown as { buffer: unknown[] }).buffer.length

    expect(buffered).toBeLessThanOrEqual(1_000)

    // The newest are the ones kept: during an ongoing failure the most recent
    // errors say more about what is happening than the oldest.
    const pending = (store as unknown as { buffer: { message: string }[] }).buffer

    expect(pending.at(-1)?.message).toBe('event 1199')
    expect(pending.at(0)?.message).not.toBe('event 0')

    repairWrites(store)
    store.flush()

    expect(store.listIssues().total).toBeGreaterThan(0)
  })

  it('does not throw out of a read when trimming fails', () => {
    store.capture(makeEvent())
    store.flush()

    const holder = store as unknown as { trimEventsFor: () => void }
    holder.trimEventsFor = () => { throw new Error('database is locked') }

    expect(() => store.listIssues()).not.toThrow()
  })
})

describe('retention', () => {
  /**
   * `retentionDays` was plumbed through every layer and consulted by a method
   * with no caller outside the tests, so the documented guarantee about how
   * long data is kept was simply false.
   */
  it('applies retention on startup without being asked', () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1_000

    store.capture(makeEvent({ timestamp: old }))
    store.flush()
    expect(store.listIssues().total).toBe(1)
    store.close()

    // A fresh process over the same database.
    store = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })

    expect(store.listIssues().total).toBe(0)
  })

  it('keeps events inside the window', () => {
    store.capture(makeEvent({ timestamp: Date.now() - 24 * 60 * 60 * 1_000 }))
    store.flush()
    store.close()

    store = new MonitorStore({ dir, retentionDays: 14, maxEventsPerIssue: 5, flushInterval: 60_000 })

    expect(store.listIssues().total).toBe(1)
  })
})

describe('per-occurrence message', () => {
  /**
   * Fingerprinting normalises ids out of the message, so occurrences with
   * different ids group together — and each still has its own text. Reading
   * the message off the issue showed the newest id on every row.
   */
  it('keeps the message each occurrence reported', () => {
    const fp = store.capture(makeEvent({ message: 'User 111 not found' }))
    store.capture(makeEvent({ message: 'User 222 not found' }))
    store.flush()

    const messages = store.getEvents(fp).map(event => event.message)

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
  function makeStore(maxIssues: number): MonitorStore {
    return new MonitorStore({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 5,
      maxIssues,
      flushInterval: 60_000,
    })
  }

  it('evicts down to the ceiling when fingerprints run away', () => {
    store.close()
    store = makeStore(10)

    // Each message is unique in a way normalisation cannot strip, so each
    // becomes its own issue.
    for (let i = 0; i < 50; i++) {
      store.capture(makeEvent({
        message: `failed for widget kx${i}zq`,
        stack: `Error: x\n    at f (/app/w${i}.ts:1:1)`,
      }))
    }
    store.flush()
    store.purge()

    expect(store.listIssues({ limit: 200 }).total).toBe(10)
  })

  it('keeps what is recent and frequent, drops what is stale and rare', () => {
    store.close()
    store = makeStore(2)

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

    store.flush()
    store.purge()

    const messages = store.listIssues().issues.map(issue => issue.message)

    expect(messages).toContain('happening right now')
    expect(messages).not.toContain('ancient one-off')
  })

  it('leaves no orphaned events behind an evicted issue', () => {
    store.close()
    store = makeStore(1)

    for (let i = 0; i < 5; i++) {
      store.capture(makeEvent({
        message: `distinct ${i}`,
        stack: `Error: x\n    at f (/app/d${i}.ts:1:1)`,
      }))
    }
    store.flush()
    store.purge()

    const orphans = (store as unknown as {
      db: { prepare: (sql: string) => { get: () => { n: number } } }
    }).db.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE fingerprint NOT IN (SELECT fingerprint FROM issues)',
    ).get()

    expect(Number(orphans.n)).toBe(0)
  })

  it('does nothing while the database is under the ceiling', () => {
    store.capture(makeEvent())
    store.flush()

    expect(store.purge().issues).toBe(0)
    expect(store.listIssues().total).toBe(1)
  })
})

describe('counter bucket alignment', () => {
  /**
   * `request_stats.bucket` holds the start of each minute, so comparing it
   * against a raw timestamp dropped the bucket the window opens inside — the
   * denominator lost up to a minute of traffic while the errors in that same
   * minute were still counted, inflating every rate on the overview.
   */
  it('counts the bucket the window starts inside', () => {
    const now = Date.now()
    // Half a minute in: floor(at / 60_000) is before `now - windowMs`.
    const at = now - 30_000

    store.countRequest('/api/x', 'GET', 200, at)
    store.flush()

    expect(store.overview(60_000, now).requestCount).toBe(1)
  })

  it('still excludes traffic from before the window', () => {
    const now = Date.now()

    store.countRequest('/api/x', 'GET', 200, now - 10 * 60_000)
    store.flush()

    expect(store.overview(60_000, now).requestCount).toBe(0)
  })
})
