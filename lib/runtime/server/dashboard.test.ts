import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MonitorEvent } from '../../types'
import { MonitorStore } from './store'

/**
 * The dashboard's numbers.
 *
 * What is worth testing here is not that the counts are counts — it is that
 * nothing is reported alone. A breakdown that ranks by error count answers
 * "which browser is most popular", which the reader already knew; the whole
 * screen turns on comparing each slice against its share of the audience.
 */

const HOUR = 60 * 60 * 1_000

let dir: string
let store: MonitorStore

function event(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    side: 'server',
    type: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at handler (/app/server/api/x.ts:3:9)',
    timestamp: Date.now(),
    ...overrides,
  }
}

function agent(browser: string) {
  return { browser, browserVersion: '1', os: 'Linux', osVersion: '1', deviceType: 'desktop' }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-dashboard-'))
  store = await MonitorStore.open({
    dir,
    retentionDays: 14,
    maxEventsPerIssue: 100,
    flushSize: 10_000,
    flushInterval: 60_000,
  })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('relative to traffic', () => {
  it('ranks a small browser with many errors above a big one with few', async () => {
    // The entire point. Chrome is 90% of the audience, so its errors are
    // expected; Safari at a tenth of the traffic producing as many is the
    // finding, and ranking by count alone would bury it.
    for (let index = 0; index < 270; index++) {
      store.countTraffic(agent('Chrome'))
    }

    // Above MIN_TRAFFIC, or the floor would discard it — which is the correct
    // behaviour and would make this test prove nothing.
    for (let index = 0; index < 30; index++) {
      store.countTraffic(agent('Safari'))
    }

    for (let index = 0; index < 10; index++) {
      store.capture(event({ facets: { browser: 'Chrome' } }))
      store.capture(event({ facets: { browser: 'Safari' } }))
    }

    await store.flush()

    const { breakdowns } = await store.dashboard({ windowMs: HOUR })
    const browser = breakdowns.find(entry => entry.facet === 'browser')

    expect(browser?.slices[0]?.value).toBe('Safari')
    expect(browser?.slices[0]?.lift).toBeCloseTo(5, 0)
  })

  it('does not trust a slice with almost no traffic', async () => {
    // Three page views and one error is a lift of two hundred, and it would
    // top every list forever. The floor is what keeps the ranking from being a
    // list of rare user agents.
    for (let index = 0; index < 100; index++) {
      store.countTraffic(agent('Chrome'))
      store.capture(event({ facets: { browser: 'Chrome' } }))
    }

    store.countTraffic(agent('Lynx'))
    store.capture(event({ facets: { browser: 'Lynx' } }))

    await store.flush()

    const browser = (await store.dashboard({ windowMs: HOUR }))
      .breakdowns.find(entry => entry.facet === 'browser')

    expect(browser?.slices.find(slice => slice.value === 'Lynx')?.lift).toBeUndefined()
  })

  it('carries no lift for a dimension the audience is not counted by', async () => {
    // Route, release, kind and group describe the request or the code, not the
    // visitor. Inventing a baseline for them would be inventing a number.
    store.capture(event({ kind: 'api' }))
    await store.flush()

    const kind = (await store.dashboard({ windowMs: HOUR }))
      .breakdowns.find(entry => entry.facet === 'kind')

    expect(kind?.slices[0]?.value).toBe('api')
    expect(kind?.slices[0]?.lift).toBeUndefined()
  })
})

describe('totals', () => {
  it('reports traffic beside errors', async () => {
    store.countRequest('/api/x', 'GET', 200)
    store.countRequest('/api/x', 'GET', 500)
    store.capture(event())
    await store.flush()

    const { totals } = await store.dashboard({ windowMs: HOUR })

    expect(totals.requests).toBe(2)
    expect(totals.failed).toBe(1)
    expect(totals.errorRate).toBeCloseTo(0.5)
    expect(totals.events).toBe(1)
  })

  it('leaves the rate undefined when nothing was served', async () => {
    // "No data" and "nothing failed" are opposite statements, and 0% is the
    // reassuring one.
    store.capture(event())
    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR })).totals.errorRate).toBeUndefined()
  })

  it('counts issues that appeared inside the window', async () => {
    store.capture(event())
    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR })).totals.newIssues).toBe(1)
  })
})

describe('the trend', () => {
  it('carries requests and errors on the same columns', async () => {
    // Drawn together because the pair is the meaning: errors rising with
    // traffic is a busy afternoon, errors rising against flat traffic is a
    // deploy.
    store.countRequest('/api/x', 'GET', 200)
    store.capture(event())
    await store.flush()

    const { trend } = await store.dashboard({ windowMs: HOUR })
    const busy = trend.filter(point => point.requests > 0 || point.errors > 0)

    expect(busy).toHaveLength(1)
    expect(busy[0]).toMatchObject({ requests: 1, errors: 1 })
  })

  it('includes the empty columns', async () => {
    // A gap drawn as a missing column reads as a shorter window rather than as
    // a quiet hour.
    store.capture(event())
    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR })).trend.length).toBeGreaterThan(10)
  })
})

describe('the tail', () => {
  it('says how many errors the rows do not cover', async () => {
    // A breakdown that silently shows six of forty values invites the reader
    // to add them up and believe the total.
    for (let index = 0; index < 10; index++) {
      store.capture(event({ facets: { browser: `Browser${index}` } }))
    }

    await store.flush()

    const browser = (await store.dashboard({ windowMs: HOUR }))
      .breakdowns.find(entry => entry.facet === 'browser')

    expect(browser?.slices).toHaveLength(6)
    expect(browser?.otherErrors).toBe(4)
  })
})

describe('filtering', () => {
  it('narrows every number on the screen at once', async () => {
    store.capture(event({ facets: { browser: 'Chrome' } }))
    store.capture(event({ facets: { browser: 'Safari' } }))
    await store.flush()

    const filtered = await store.dashboard({ windowMs: HOUR, filter: { browser: ['Safari'] } })

    expect(filtered.totals.events).toBe(1)
    expect(filtered.breakdowns.find(entry => entry.facet === 'browser')?.slices)
      .toHaveLength(1)
  })
})

describe('deploys', () => {
  it('marks where a release first appeared', async () => {
    // The whole point of drawing them on the chart: "it started after the
    // deploy" is a statement about what the line does either side of a moment,
    // and a filter by release cannot answer it — narrowing to one release
    // hides the comparison being made.
    // Distinct timestamps, because two releases starting in the same
    // millisecond is not a deploy — it is a test writing two rows at once,
    // and ordering them would be ordering noise.
    const now = Date.now()

    store.capture(event({ timestamp: now - 10 * 60_000, facets: { release: '1.8.1' } }))
    store.capture(event({ message: 'later', timestamp: now, facets: { release: '1.8.2' } }))
    await store.flush()

    const { deploys } = await store.dashboard({ windowMs: HOUR, now })

    expect(deploys.map(entry => entry.release)).toEqual(['1.8.1', '1.8.2'])
    // Each release introduced the issue that first carried it.
    expect(deploys.every(entry => entry.newIssues === 1)).toBe(true)
  })

  it('says nothing when no release is configured', async () => {
    // Events carry `unknown` when `release` is unset, and a line for it would
    // mark when collection started rather than when anything shipped.
    store.capture(event())
    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR })).deploys).toEqual([])
  })

  it('leaves out a release that started before the window', async () => {
    // A release already running is not a deploy *in* this window; a line at
    // the left edge would mark the beginning of the chart, not an event on it.
    const now = Date.now()

    store.capture(event({ timestamp: now - 3 * HOUR, facets: { release: 'old' } }))
    store.capture(event({ message: 'fresh', facets: { release: 'new' } }))
    await store.flush()

    const { deploys } = await store.dashboard({ windowMs: HOUR, now })

    expect(deploys.map(entry => entry.release)).toEqual(['new'])
  })
})
