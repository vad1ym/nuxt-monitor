import { defineEventHandler, getQuery } from '#imports'
import { parseSide, requireDashboardAccess, useMonitorStore } from '../context'
import { parseFacetFilter } from '../facets'

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
    search: toText(query.search),
    type: toText(query.type),
    facets: parseFacetFilter(query),
    limit: toInt(query.limit, 50),
    offset: toInt(query.offset, 0),
  })
})

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
