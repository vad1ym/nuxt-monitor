import { describe, expect, it } from 'vitest'
import type { MonitorFacetCounts, MonitorFacetName } from '../lib/types'
import { dominantSlice } from './dominant'

/** Builds counts for the named facets; the rest come back empty. */
function counts(input: Partial<Record<MonitorFacetName, [string, number][]>>): MonitorFacetCounts {
  const names: MonitorFacetName[] = [
    'browser',
    'browserVersion',
    'os',
    'osVersion',
    'deviceType',
    'release',
    'route',
  ]

  const result = {} as MonitorFacetCounts

  for (const name of names) {
    const rows = input[name] ?? []
    const total = rows.reduce((sum, [, count]) => sum + count, 0)

    result[name] = {
      values: rows.map(([value, count]) => ({
        value,
        count,
        share: total ? count / total : 0,
      })),
      more: false,
    }
  }

  return result
}

describe('dominantSlice', () => {
  it('finds nothing when no slice stands out', () => {
    const spread = counts({ os: [['iOS', 40], ['Windows', 35], ['Android', 25]] })

    expect(dominantSlice(spread)).toBeUndefined()
  })

  it('reports a slice that covers most of the occurrences', () => {
    const skewed = counts({ os: [['iOS', 90], ['Windows', 10]] })

    expect(dominantSlice(skewed)).toMatchObject({ facet: 'os', value: 'iOS', count: 90 })
  })

  /**
   * The condition that keeps the summary honest: if the whole audience is on
   * iOS, then errors on iOS are the audience, not a finding.
   */
  it('stays silent when the slice merely mirrors normal traffic', () => {
    const issue = counts({ os: [['iOS', 90], ['Windows', 10]] })
    const traffic = counts({ os: [['iOS', 9_000], ['Windows', 1_000]] })

    expect(dominantSlice(issue, traffic)).toBeUndefined()
  })

  it('reports the slice when it is skewed against normal traffic', () => {
    const issue = counts({ os: [['iOS', 90], ['Windows', 10]] })
    const traffic = counts({ os: [['iOS', 1_000], ['Windows', 9_000]] })

    const slice = dominantSlice(issue, traffic)

    expect(slice).toMatchObject({ facet: 'os', value: 'iOS' })
    expect(slice!.lift).toBeCloseTo(9, 1)
  })

  /** A value absent from normal traffic is as skewed as a slice can be. */
  it('treats a slice missing from the baseline as maximally skewed', () => {
    const issue = counts({ browser: [['Firefox', 100]] })
    const traffic = counts({ browser: [['Chrome', 10_000]] })

    expect(dominantSlice(issue, traffic)!.lift).toBe(Number.POSITIVE_INFINITY)
  })

  it('ignores a high share built from too few events', () => {
    expect(dominantSlice(counts({ os: [['iOS', 3]] }))).toBeUndefined()
  })

  /**
   * `unknown` is what an unrecorded facet reports. It is a true answer and a
   * useless one — never a finding.
   */
  it('never reports the unknown bucket', () => {
    expect(dominantSlice(counts({ browser: [['unknown', 100]] }))).toBeUndefined()
  })

  it('prefers the more specific facet when several qualify', () => {
    const both = counts({
      os: [['iOS', 100]],
      osVersion: [['16.3', 100]],
    })

    // Same share and no baseline, so priority decides: a version narrows the
    // search further than the OS name.
    expect(dominantSlice(both)!.facet).toBe('osVersion')
  })

  /**
   * "Every occurrence of this error is on the page this error is thrown from"
   * is a restatement of where the code lives. Left unchecked it reaches 100%
   * and outranks the browser skew that is the actual answer.
   */
  it('does not report a route that covers every occurrence', () => {
    const single = counts({
      route: [['/cart', 50]],
      osVersion: [['15.4', 46], ['10', 4]],
    })

    expect(dominantSlice(single)).toMatchObject({ facet: 'osVersion', value: '15.4' })
  })

  it('still reports a route that dominates without covering everything', () => {
    const mostly = counts({ route: [['/cart', 92], ['/account', 8]] })

    expect(dominantSlice(mostly)).toMatchObject({ facet: 'route', value: '/cart' })
  })

  /**
   * An unknown skew is not a weak skew. Scoring an absent lift as zero would
   * put every unmeasurable facet below every measurable one, however weak.
   */
  it('ranks a facet with no baseline on its share rather than last', () => {
    const issue = counts({
      // No baseline entry, so no lift can be computed.
      deviceType: [['mobile', 100]],
      // Measured, and only just past the threshold.
      os: [['iOS', 66], ['Windows', 34]],
    })

    const baseline = counts({ os: [['iOS', 5_000], ['Windows', 5_000]] })
    const slice = dominantSlice(issue, baseline)!

    // os lift is 0.66/0.5 = 1.32, which loses to deviceType's share of 1.0
    // only if an absent lift is scored as zero. It is not.
    expect(slice.facet).toBe('os')

    // With the measured facet gone, the unmeasurable one is still reported
    // rather than discarded.
    const alone = counts({ deviceType: [['mobile', 100]] })

    expect(dominantSlice(alone, baseline)).toMatchObject({ facet: 'deviceType' })
  })

  /** "92% on 15" names nothing; the version needs its subject. */
  it('qualifies a version with the browser it belongs to', () => {
    const slice = dominantSlice(counts({
      browser: [['Mobile Safari', 46], ['Chrome', 4]],
      browserVersion: [['15', 46], ['120', 4]],
    }))

    expect(slice).toMatchObject({ facet: 'browserVersion', value: '15', label: 'Mobile Safari 15' })
  })

  it('leaves a version unqualified when the browsers behind it are mixed', () => {
    const slice = dominantSlice(counts({
      // Two browsers happen to share a version number, so naming one would be
      // a guess dressed up as a fact.
      browser: [['Chrome', 30], ['Edge', 30]],
      browserVersion: [['120', 60]],
    }))

    expect(slice).toMatchObject({ facet: 'browserVersion', label: '120' })
  })

  it('handles missing input without throwing', () => {
    expect(dominantSlice(null)).toBeUndefined()
    expect(dominantSlice(undefined)).toBeUndefined()
    expect(dominantSlice(counts({}))).toBeUndefined()
  })
})

describe('qualifying a version', () => {
  const counts = (browser: string, version: string): MonitorFacetCounts => ({
    browser: { values: [{ value: browser, count: 10, share: 1 }], more: false },
    browserVersion: { values: [{ value: version, count: 10, share: 1 }], more: false },
    os: { values: [], more: false },
    osVersion: { values: [], more: false },
    deviceType: { values: [], more: false },
    release: { values: [], more: false },
    route: { values: [], more: false },
  })

  it('names the browser a bare version belongs to', () => {
    // "92% on 15" names nothing.
    const slice = dominantSlice(counts('Mobile Safari', '15'), 10)

    expect(slice?.label).toContain('Mobile Safari 15')
  })

  it('does not repeat a version that already names its browser', () => {
    // Some agents report the version already qualified, and prefixing it again
    // gives "Mobile Safari Mobile Safari 15" — which reads as a parsing bug.
    const slice = dominantSlice(counts('Mobile Safari', 'Mobile Safari 15'), 10)

    expect(slice?.label).toBe('Mobile Safari 15')
  })
})
