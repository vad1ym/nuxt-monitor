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
    store.countTraffic(agent('Chrome'), Date.now() - 8 * 24 * 60 * 60 * 1_000)
    store.countTraffic(agent('Safari'))
    await store.flush()

    const recent = await store.trafficFacets(24 * 60 * 60 * 1_000)

    expect(recent.browser.values.map(value => value.value)).toEqual(['Safari'])
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
    store.countTraffic(agent('Chrome'), Date.now() - 60 * 24 * 60 * 60 * 1_000)
    store.countTraffic(agent('Safari'))
    await store.flush()
    await store.purge()

    const kept = await store.trafficFacets(90 * 24 * 60 * 60 * 1_000)

    // Kept exactly as long as `request_stats`: both are denominators, and a
    // baseline that expired first would silently stop qualifying breakdowns.
    expect(kept.browser.values.map(value => value.value)).toEqual(['Safari'])
  })
})
