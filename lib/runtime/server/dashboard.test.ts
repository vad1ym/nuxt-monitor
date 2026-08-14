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
    // Timestamped from the same `now` the window is measured against, not from
    // the helper's own `Date.now()`. A deploy is excluded when it falls after
    // the end of the window, and the helper's clock reading is taken later than
    // this one — so whenever a millisecond ticked between the two, the release
    // under test landed in the future and was dropped.
    store.capture(event({ message: 'fresh', timestamp: now, facets: { release: 'new' } }))
    await store.flush()

    const { deploys } = await store.dashboard({ windowMs: HOUR, now })

    expect(deploys.map(entry => entry.release)).toEqual(['new'])
  })
})

/**
 * The release line under the tiles.
 *
 * It sits inches below figures for the selected window, so its own figures
 * have to be for that window too. They were not: the counts came from a
 * lifetime query, and the screen showed one hour's errors beside a release's
 * entire history with nothing marking the difference.
 */
describe('the latest release line', () => {
  it('counts only events inside the window', async () => {
    const now = Date.now()

    store.capture(event({ timestamp: now - 3 * HOUR, facets: { release: '2.0.0' } }))
    store.capture(event({ timestamp: now - 2 * HOUR, facets: { release: '2.0.0' } }))
    store.capture(event({ timestamp: now - 60_000, facets: { release: '2.0.0' } }))
    await store.flush()

    const { latestRelease } = await store.dashboard({ windowMs: HOUR, now })

    // Three occurrences exist; one happened in the last hour.
    expect(latestRelease?.release).toBe('2.0.0')
    expect(latestRelease?.events).toBe(1)
  })

  it('still credits the release that introduced the issue', async () => {
    // "Introduced" is a fact about the deploy, not about the window. Scoping
    // it would hand every issue to whatever shipped most recently, so a
    // one-hour window would report the newest release as the cause of
    // everything still happening under it.
    const now = Date.now()

    store.capture(event({ timestamp: now - 5 * HOUR, facets: { release: '1.0.0' } }))
    store.capture(event({ timestamp: now - 60_000, facets: { release: '2.0.0' } }))
    await store.flush()

    const { latestRelease } = await store.dashboard({ windowMs: HOUR, now })

    // The issue first appeared in 1.0.0, which is outside the window, so 2.0.0
    // introduced nothing and the line has nothing to report.
    expect(latestRelease).toBeUndefined()
  })

  it('drops a release with nothing in the window', async () => {
    // Otherwise a release that last ran yesterday is described by yesterday's
    // numbers on a screen showing the last hour.
    const now = Date.now()

    store.capture(event({ timestamp: now - 5 * HOUR, facets: { release: '1.0.0' } }))
    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR, now })).latestRelease).toBeUndefined()
    // The same data over a window that contains it does report.
    expect((await store.dashboard({ windowMs: 24 * HOUR, now })).latestRelease?.release)
      .toBe('1.0.0')
  })
})

describe('the window before this one', () => {
  /**
   * Why the comparison exists: an absolute count is close to unreadable. "120
   * errors" is a quiet morning or a fire depending entirely on what the window
   * before it held, and nothing on the screen used to say which.
   */
  const now = Date.now()

  it('reports the previous window beside the current one', async () => {
    // Two windows, one event each side, deliberately different counts.
    store.capture(event({ timestamp: now - 30 * 60_000 }))
    store.capture(event({ message: 'older', timestamp: now - 90 * 60_000 }))
    store.capture(event({ message: 'older too', timestamp: now - 100 * 60_000 }))
    await store.flush()

    const { totals, previous } = await store.dashboard({ windowMs: HOUR, now })

    expect(totals.events).toBe(1)
    expect(previous?.events).toBe(2)
  })

  it('does not count the current window in the previous one', async () => {
    // The bug this guards: `totalsFor` was open-ended at `now`, so asking it
    // about the earlier window would have counted everything since — the
    // current window included, compared against itself.
    store.capture(event({ timestamp: now - 5 * 60_000 }))
    await store.flush()

    const { previous } = await store.dashboard({ windowMs: HOUR, now })

    // Requests, not events, decide whether the window was observed at all —
    // here neither exists, so there is nothing to compare against.
    expect(previous).toBeUndefined()
  })

  it('says nothing at all when there was no previous window', async () => {
    // A monitor installed this morning has nothing behind it, and "up from 0"
    // would be the loudest possible claim made from no evidence — on the first
    // day of every installation.
    store.capture(event({ timestamp: now - 10 * 60_000 }))
    store.countRequest('/api/x', 'GET', 200, now - 10 * 60_000)
    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR, now })).previous).toBeUndefined()
  })

  it('reports a previous window that was healthy rather than absent', async () => {
    // The distinction that keeps this honest: a quiet previous window is a
    // real measurement, and errors going 0 → 40 is exactly the comparison
    // worth drawing. Only the absence of *both* traffic and errors means the
    // window was never observed.
    store.countRequest('/api/x', 'GET', 200, now - 90 * 60_000)
    store.capture(event({ timestamp: now - 10 * 60_000 }))
    await store.flush()

    const { previous } = await store.dashboard({ windowMs: HOUR, now })

    expect(previous).toBeDefined()
    expect(previous?.events).toBe(0)
    expect(previous?.requests).toBe(1)
  })

  it('carries the previous failure rate', async () => {
    store.countRequest('/api/x', 'GET', 200, now - 90 * 60_000)
    store.countRequest('/api/x', 'GET', 500, now - 90 * 60_000)
    store.countRequest('/api/x', 'GET', 200, now - 10 * 60_000)
    await store.flush()

    const { totals, previous } = await store.dashboard({ windowMs: HOUR, now })

    expect(previous?.errorRate).toBeCloseTo(0.5)
    expect(totals.errorRate).toBeCloseTo(0)
  })
})

describe('the session denominator', () => {
  /**
   * The number `affectedSessions` was missing. "5 sessions saw an error" is an
   * outage out of 20 and a rounding error out of 200,000, and before this the
   * dashboard only ever had the numerator: a browser spoke to the server only
   * once something had already gone wrong.
   */
  it('counts sessions that visited without anything breaking', async () => {
    store.countSession('a')
    store.countSession('b')
    store.countSession('c')
    await store.flush()

    const { totals } = await store.dashboard({ windowMs: HOUR })

    expect(totals.sessions).toBe(3)
    expect(totals.affectedSessions).toBe(0)
  })

  it('counts a session once however often it says hello', async () => {
    // A single-page app says hello on every page load, and the client posts
    // its session with every batch of errors as well.
    for (let i = 0; i < 20; i++) {
      store.countSession('a')
    }

    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR })).totals.sessions).toBe(1)
  })

  it('reports zero where nothing ever said hello', async () => {
    // A database predating session counting, or an app whose client collector
    // is not running. Zero has to read as "no baseline" rather than as "nobody
    // visited", which is why the tile withholds the share instead of showing
    // 0%.
    store.capture(event())
    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR })).totals.sessions).toBe(0)
  })

  it('does not confuse sessions with the facet breakdowns', async () => {
    // Sessions ride in `traffic_facets` under their own facet name. If that
    // name leaked into the breakdown list it would appear as a browser.
    store.countSession('a')
    store.countTraffic(agent('Chrome'))
    await store.flush()

    const { breakdowns } = await store.dashboard({ windowMs: HOUR })

    expect(breakdowns.flatMap(b => b.slices.map(s => s.value))).not.toContain('total')
  })
})

describe('latency', () => {
  /**
   * The measurement that separates a monitor from an error tracker. Everything
   * else here begins with something throwing, so an application answering 200
   * in eight seconds registered nowhere at all — error rate zero, issue list
   * empty, and unusable for everybody trying to use it.
   */
  it('measures requests that did not fail', async () => {
    store.countLatency('/api/x', 30)
    store.countLatency('/api/x', 40)
    await store.flush()

    const { latency } = await store.dashboard({ windowMs: HOUR })

    expect(latency.requests).toBe(2)
    expect(latency.p50).toBeGreaterThan(0)
  })

  it('reports no percentile where nothing was measured', async () => {
    // "No data" and "instant" are different answers, and only one of them is
    // reassuring.
    const { latency } = await store.dashboard({ windowMs: HOUR })

    expect(latency.requests).toBe(0)
    expect(latency.p95).toBeUndefined()
  })

  it('separates a slow endpoint from a fast one', async () => {
    // The finding an overall average hides: one endpoint degrading is
    // invisible in a figure averaged across all of them.
    for (let i = 0; i < 50; i++) {
      store.countLatency('/api/fast', 20)
      store.countLatency('/api/slow', 5_000)
    }

    await store.flush()

    const { latency } = await store.dashboard({ windowMs: HOUR })

    // Ranked by the tail, so the slow one leads however much traffic the fast
    // one carries.
    expect(latency.routes[0]!.route).toBe('/api/slow')
    expect(latency.routes[0]!.p95).toBeGreaterThan(1_000)
    expect(latency.routes.find(r => r.route === '/api/fast')!.p95).toBeLessThan(100)
  })

  it('collapses variable paths into one route, like the other counters', async () => {
    // Otherwise every id in production becomes its own row and the table grows
    // with traffic rather than with the size of the application.
    store.countLatency('/users/1', 30)
    store.countLatency('/users/2', 30)
    await store.flush()

    const { latency } = await store.dashboard({ windowMs: HOUR })

    expect(latency.routes).toHaveLength(1)
    expect(latency.routes[0]!.requests).toBe(2)
  })

  it('ignores a nonsensical reading rather than storing it', async () => {
    // A negative duration means the clock moved backwards between two
    // readings; recording it would drag the whole distribution down.
    store.countLatency('/api/x', -5)
    store.countLatency('/api/x', Number.NaN)
    await store.flush()

    expect((await store.dashboard({ windowMs: HOUR })).latency.requests).toBe(0)
  })
})
