import { describe, expect, it } from 'vitest'
import { facetClause, isFacetName, parseFacetFilter } from './facets'

describe('isFacetName', () => {
  it('accepts the known dimensions and nothing else', () => {
    expect(isFacetName('browser')).toBe(true)
    expect(isFacetName('deviceType')).toBe(true)
    expect(isFacetName('nope')).toBe(false)
    expect(isFacetName(42)).toBe(false)
  })

  /**
   * Facet names become column names in SQL, where they cannot be bound as
   * parameters. Inherited properties must not pass for real ones.
   */
  it('rejects names inherited from Object.prototype', () => {
    expect(isFacetName('constructor')).toBe(false)
    expect(isFacetName('toString')).toBe(false)
    expect(isFacetName('__proto__')).toBe(false)
  })
})

describe('parseFacetFilter', () => {
  it('reads repeated and comma-separated parameters alike', () => {
    expect(parseFacetFilter({ browser: ['Chrome', 'Firefox'] })).toEqual({
      browser: ['Chrome', 'Firefox'],
    })

    expect(parseFacetFilter({ browser: 'Chrome,Firefox' })).toEqual({
      browser: ['Chrome', 'Firefox'],
    })
  })

  it('ignores parameters that are not facets', () => {
    expect(parseFacetFilter({ search: 'boom', limit: '10' })).toEqual({})
  })

  it('drops empty values rather than filtering on them', () => {
    expect(parseFacetFilter({ browser: ' , ,' })).toEqual({})
    expect(parseFacetFilter({ os: undefined })).toEqual({})
  })
})

describe('facetClause', () => {
  it('is empty when nothing is filtered', () => {
    expect(facetClause(undefined)).toEqual({ sql: '', params: [] })
    expect(facetClause({})).toEqual({ sql: '', params: [] })
  })

  /**
   * Values within one facet are OR-ed and separate facets AND-ed — picking two
   * browsers widens the result, adding an OS narrows it.
   */
  it('ORs within a facet and ANDs across facets', () => {
    const clause = facetClause({ browser: ['Chrome', 'Firefox'], os: ['iOS'] })

    expect(clause.sql).toBe('AND browser IN (?, ?) AND os IN (?)')
    expect(clause.params).toEqual(['Chrome', 'Firefox', 'iOS'])
  })

  it('maps a facet name to its column', () => {
    expect(facetClause({ browserVersion: ['16'] }).sql).toBe('AND browser_version IN (?)')
    expect(facetClause({ deviceType: ['mobile'] }).sql).toBe('AND device_type IN (?)')
  })

  /** The filter comes from a URL, so a caller must not be able to make the
   * query arbitrarily large. */
  it('bounds the number and length of values', () => {
    const many = facetClause({ browser: Array.from({ length: 100 }, (_, i) => `b${i}`) })

    expect(many.params).toHaveLength(20)

    const long = facetClause({ browser: ['x'.repeat(1_000)] })

    expect(long.params[0]).toHaveLength(200)
  })

  /**
   * Values are always bound, never interpolated — the column name is the only
   * thing spliced into the SQL, and it comes from a fixed map.
   */
  it('binds values rather than inlining them', () => {
    const clause = facetClause({ browser: ['\' OR 1=1 --'] })

    expect(clause.sql).toBe('AND browser IN (?)')
    expect(clause.params).toEqual(['\' OR 1=1 --'])
  })
})
