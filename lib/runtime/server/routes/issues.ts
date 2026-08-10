import { defineEventHandler, getQuery } from '#imports'
import { parseSide, requireDashboardAccess, useMonitorStore } from '../context'
import { parseFacetFilter } from '../facets'
import type { MonitorIssueSort } from '../queries'

export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const query = getQuery(event)
  const store = await useMonitorStore()

  const resolved = query.resolved === undefined
    ? undefined
    : query.resolved === 'true' || query.resolved === '1'

  return store.listIssues({
    side: parseSide(query.side),
    resolved,
    ignored: query.ignored === 'true' || query.ignored === '1',
    sort: parseSort(query.sort),
    search: toText(query.search),
    type: toText(query.type),
    facets: parseFacetFilter(query),
    limit: toInt(query.limit, 50),
    offset: toInt(query.offset, 0),
  })
})

/**
 * Only a name from the fixed set reaches the query.
 *
 * The sort becomes an `ORDER BY` clause, so an unrecognised value must fall
 * back rather than travel — the query looks it up in a table for the same
 * reason.
 */
function parseSort(value: unknown): MonitorIssueSort | undefined {
  const sorts: MonitorIssueSort[] = ['last-seen', 'count', 'first-seen']

  return sorts.find(sort => sort === value)
}

function toText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''

  // Bounded: this reaches a LIKE pattern, and an unbounded term would let a
  // caller make the scan arbitrarily expensive.
  return text ? text.slice(0, 200) : undefined
}

function toInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
