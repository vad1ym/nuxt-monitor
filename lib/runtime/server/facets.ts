import type { MonitorFacetFilter, MonitorFacetName } from '../../types'

/**
 * Facet plumbing, kept in one place.
 *
 * Facet names arrive from the browser as query parameters, and they end up in
 * SQL as column names — which cannot be bound as parameters. The safety of
 * every facet query therefore rests on names never reaching SQL unless they
 * came out of this map, so the mapping and the validation live together and
 * there is exactly one way in.
 */
const COLUMNS = {
  browser: 'browser',
  browserVersion: 'browser_version',
  os: 'os',
  osVersion: 'os_version',
  deviceType: 'device_type',
  release: '`release`',
  route: 'route',
} as const satisfies Record<MonitorFacetName, string>

export const FACET_NAMES = Object.keys(COLUMNS) as MonitorFacetName[]

/** Cap on values per facet in one filter, so a URL cannot build a huge query. */
const MAX_VALUES = 20
const MAX_VALUE_LENGTH = 200

export function isFacetName(value: unknown): value is MonitorFacetName {
  return typeof value === 'string' && Object.hasOwn(COLUMNS, value)
}

/** The column a facet is stored in. Only ever called with a validated name. */
export function facetColumn(name: MonitorFacetName): string {
  return COLUMNS[name]
}

/**
 * Turns a filter into a SQL fragment and its bound parameters.
 *
 * Values of one facet are OR-ed and different facets are AND-ed, which is what
 * makes a facet panel behave the way people expect: picking Chrome *and*
 * Firefox widens, picking Chrome *and* iOS narrows.
 */
export function facetClause(filter: MonitorFacetFilter | undefined): {
  sql: string
  params: string[]
} {
  const parts: string[] = []
  const params: string[] = []

  for (const name of FACET_NAMES) {
    const values = filter?.[name]

    if (!values?.length) {
      continue
    }

    const bounded = values.slice(0, MAX_VALUES).map(value => String(value).slice(0, MAX_VALUE_LENGTH))
    const placeholders = bounded.map(() => '?').join(', ')

    // The column name is interpolated, never bound — SQLite does not accept a
    // parameter there. It is safe only because it came from `COLUMNS`.
    parts.push(`${facetColumn(name)} IN (${placeholders})`)
    params.push(...bounded)
  }

  return {
    sql: parts.length ? parts.map(part => `AND ${part}`).join(' ') : '',
    params,
  }
}

/**
 * Reads a filter out of query parameters.
 *
 * Accepts `?browser=Chrome&browser=Firefox` and the comma form
 * `?browser=Chrome,Firefox`, since both are natural to type by hand.
 */
export function parseFacetFilter(query: Record<string, unknown>): MonitorFacetFilter {
  const filter: MonitorFacetFilter = {}

  for (const [key, raw] of Object.entries(query)) {
    if (!isFacetName(key) || raw === undefined || raw === null) {
      continue
    }

    const values = (Array.isArray(raw) ? raw : [raw])
      .flatMap(value => String(value).split(','))
      .map(value => value.trim())
      .filter(Boolean)

    if (values.length) {
      filter[key] = values
    }
  }

  return filter
}
