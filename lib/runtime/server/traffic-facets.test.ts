import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MonitorStore } from './store'

/**
 * The traffic baseline.
 *
 * What makes a breakdown mean something: "90% of these errors are on iOS 16"
 * is a finding when iOS 16 is a tenth of the audience and a tautology when it
 * is nine tenths. Until this table existed the comparison was against the
 * facets of *other errors*, which answers a different question entirely.
 */

let dir: string
let store: MonitorStore

/** What `parseUserAgent` hands back, as far as the counter cares. */
function agent(browser: string, os = 'iOS', deviceType = 'mobile') {
  return { browser, browserVersion: '17', os, osVersion: '16', deviceType }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-traffic-'))
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

describe('counting', () => {
  it('records a share per dimension', async () => {
    for (let i = 0; i < 9; i++) {
      store.countTraffic(agent('Chrome', 'Android', 'mobile'))
    }

    store.countTraffic(agent('Safari', 'iOS', 'mobile'))
    await store.flush()

    const facets = await store.trafficFacets(24 * 60 * 60 * 1_000)
    const chrome = facets.browser.values.find(value => value.value === 'Chrome')

    expect(chrome?.count).toBe(9)
    expect(chrome?.share).toBeCloseTo(0.9)
  })

  it('shares are per facet, not against every row in the table', async () => {
    // Five dimensions are written per page view, so dividing by the table's
    // total would report every share at a fifth of its real value.
    store.countTraffic(agent('Chrome'))
    await store.flush()

    expect((await store.trafficFacets(60_000)).browser.values[0]?.share).toBe(1)
  })

  it('answers empty when nothing was counted', async () => {
    const facets = await store.trafficFacets(60_000)

    // Empty and absent are different: this says "no page views", which is what
    // makes a skew unjudgeable rather than merely unasked-for.
    expect(facets.browser.values).toEqual([])
    expect(facets.os.values).toEqual([])
  })

  it('skips a dimension the user agent did not carry', async () => {
    store.countTraffic({ browser: 'Chrome', browserVersion: undefined, os: undefined, osVersion: undefined, deviceType: undefined })
    await store.flush()

    const facets = await store.trafficFacets(60_000)

    expect(facets.browser.values).toHaveLength(1)
    expect(facets.os.values).toEqual([])
  })

  it('adds up across flushes', async () => {
    store.countTraffic(agent('Chrome'))
    await store.flush()
    store.countTraffic(agent('Chrome'))
    await store.flush()

    expect((await store.trafficFacets(60_000)).browser.values[0]?.count).toBe(2)
  })

  it('is bounded by the window', async () => {
    store.countTraffic(agent('Chrome'), undefined, Date.now() - 8 * 24 * 60 * 60 * 1_000)
    store.countTraffic(agent('Safari'))
    await store.flush()

    const recent = await store.trafficFacets(24 * 60 * 60 * 1_000)

    expect(recent.browser.values.map(value => value.value)).toEqual(['Safari'])
  })
})

describe('which page the traffic was on', () => {
  it('counts a page view against its route', async () => {
    store.countTraffic(agent('Chrome'), '/checkout')
    store.countTraffic(agent('Chrome'), '/checkout')
    store.countTraffic(agent('Chrome'), '/about')
    await store.flush()

    const routes = (await store.trafficFacets(60_000)).route.values

    // The ranking is the whole point: it says which page carries the traffic,
    // and therefore which one is worth a test and which breakage would be felt.
    expect(routes.map(value => value.value)).toEqual(['/checkout', '/about'])
    expect(routes[0]?.count).toBe(2)
  })

  it('collapses variable segments into one route', async () => {
    // Otherwise the busiest page in the application is split across a row per
    // id, and reads as a hundred rare pages instead of one popular one.
    store.countTraffic(agent('Chrome'), '/posts/1')
    store.countTraffic(agent('Chrome'), '/posts/2')
    await store.flush()

    const routes = (await store.trafficFacets(60_000)).route.values

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ value: '/posts/:id', count: 2 })
  })

  it('drops the query string, which is per request and not the page', async () => {
    store.countTraffic(agent('Chrome'), '/search?q=hello')
    store.countTraffic(agent('Chrome'), '/search?q=goodbye')
    await store.flush()

    expect((await store.trafficFacets(60_000)).route.values[0])
      .toMatchObject({ value: '/search', count: 2 })
  })

  it('counts the visitor even when no route was given', async () => {
    // The browser dimensions are the older contract and must not start
    // depending on a route the caller may not have.
    store.countTraffic(agent('Chrome'))
    await store.flush()

    const facets = await store.trafficFacets(60_000)

    expect(facets.browser.values).toHaveLength(1)
    expect(facets.route.values).toEqual([])
  })

  it('keeps a long route whole rather than cutting it to a prefix', async () => {
    // The column is sized for a route, so a long one is stored as it is. A
    // narrower column would be the worst outcome available: two distinct pages
    // sharing a prefix would collapse into one row, and the counter would then
    // report their combined traffic under one of their names.
    // Many real segments rather than one long one: `normalizeRoute` replaces a
    // segment over 40 characters with `:value`, so length has to come from
    // depth to survive normalisation the way a real deep route does.
    const prefix = Array.from({ length: 8 }, (_, i) => `department${i}`).join('/')
    const first = `/${prefix}/checkout`
    const second = `/${prefix}/basket`

    store.countTraffic(agent('Chrome'), first)
    store.countTraffic(agent('Chrome'), second)
    await store.flush()

    const routes = (await store.trafficFacets(60_000)).route.values

    expect(routes).toHaveLength(2)
    expect(routes.map(value => value.value).sort()).toEqual([second, first].sort())
  })

  it('does not let a forged user agent exceed the column', async () => {
    // Every other dimension comes from a header, which is attacker-controlled
    // and bounded by nothing.
    store.countTraffic({ ...agent('C'.repeat(400)), browserVersion: undefined, os: undefined, osVersion: undefined, deviceType: undefined })
    await store.flush()

    const [browser] = (await store.trafficFacets(60_000)).browser.values

    expect(browser?.count).toBe(1)
    expect(browser?.value.length).toBeLessThanOrEqual(200)
  })

  it('shares are against page views, not against every dimension written', async () => {
    store.countTraffic(agent('Chrome'), '/checkout')
    store.countTraffic(agent('Chrome'), '/about')
    await store.flush()

    // Half the traffic was on /checkout — the number a decision about testing
    // is actually made on.
    expect((await store.trafficFacets(60_000)).route.values[0]?.share).toBeCloseTo(0.5)
  })
})

describe('what it is for', () => {
  it('tells a real skew from the shape of the audience', async () => {
    // The comparison the whole table exists to make possible. Ninety per cent
    // of the traffic is Chrome, so an issue that is ninety per cent Chrome has
    // found nothing — and one that is ninety per cent Safari has.
    for (let i = 0; i < 90; i++) {
      store.countTraffic(agent('Chrome'))
    }

    for (let i = 0; i < 10; i++) {
      store.countTraffic(agent('Safari'))
    }

    await store.flush()

    const baseline = await store.trafficFacets(60_000)
    const share = (name: string): number =>
      baseline.browser.values.find(value => value.value === name)?.share ?? 0

    expect(share('Chrome')).toBeCloseTo(0.9)
    expect(share('Safari')).toBeCloseTo(0.1)
  })
})

describe('retention', () => {
  it('drops counts past the window the request counters use', async () => {
    store.countTraffic(agent('Chrome'), undefined, Date.now() - 60 * 24 * 60 * 60 * 1_000)
    store.countTraffic(agent('Safari'))
    await store.flush()
    await store.purge()

    const kept = await store.trafficFacets(90 * 24 * 60 * 60 * 1_000)

    // Kept exactly as long as `request_stats`: both are denominators, and a
    // baseline that expired first would silently stop qualifying breakdowns.
    expect(kept.browser.values.map(value => value.value)).toEqual(['Safari'])
  })
})
