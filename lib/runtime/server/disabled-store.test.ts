import { describe, expect, it } from 'vitest'
import { DisabledStore } from './disabled-store'
import { FACET_NAMES } from './facets'

/**
 * The fallback for a database that cannot be opened.
 *
 * Every method here is exercised because the point of the type is that callers
 * do not check which store they hold — so any method that throws would throw
 * from a place that has no reason to expect it.
 */
describe('DisabledStore', () => {
  const store = new DisabledStore('EACCES: permission denied')

  it('accepts captures and drops them without complaint', () => {
    expect(() => store.capture()).not.toThrow()
    expect(store.capture()).toBe('')
    expect(() => store.countRequest()).not.toThrow()
    expect(() => store.flush()).not.toThrow()
    expect(() => store.close()).not.toThrow()
  })

  it('reads as an empty database rather than an error', () => {
    expect(store.listIssues()).toEqual({ issues: [], total: 0 })
    expect(store.getIssue()).toBeUndefined()
    expect(store.getEvents()).toEqual([])
    expect(store.sessionCount()).toBe(0)
    expect(store.eventCount()).toBe(0)
    expect(store.setResolved()).toBe(false)
    expect(store.purge()).toEqual({ events: 0, issues: 0 })
  })

  /** A missing key would break the panel; an empty list renders "nothing yet". */
  it('returns every facet dimension, empty', () => {
    const facets = store.facetCounts()

    for (const name of FACET_NAMES) {
      expect(facets[name]).toEqual([])
    }
  })

  /**
   * Zero would claim the application had no failures. Nothing was measured,
   * and a monitoring tool that is not collecting must not report all-clear.
   */
  it('reports an unknown error rate, not a healthy one', () => {
    expect(store.overview().errorRate).toBeUndefined()
    expect(store.overview().totalEvents).toBe(0)
  })

  it('keeps the reason it was disabled', () => {
    expect(store.reason).toContain('EACCES')
  })

  /**
   * The one answer that must not read as "everything is fine".
   *
   * Every other method returns emptiness; if health did the same, a dashboard
   * with no errors would be indistinguishable from an application with none.
   */
  it('reports that collection is off, and why', () => {
    const health = store.health()

    expect(health.enabled).toBe(false)
    expect(health.reason).toBe('EACCES: permission denied')
  })
})
