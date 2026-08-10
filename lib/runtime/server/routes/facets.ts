import { defineEventHandler, getQuery } from '#imports'
import { requireDashboardAccess, useMonitorStore } from '../context'
import { toWindow } from './window'
import { parseFacetFilter } from '../facets'

/**
 * Facet counts across the whole window.
 *
 * Separate from `/api/issues` because the two answer different questions and
 * change at different rates: the list re-fetches on every keystroke in the
 * search box, while the panel beside it only needs to move when the filter or
 * the window does.
 */
export default defineEventHandler((event) => {
  requireDashboardAccess(event)

  const query = getQuery(event)
  const windowMs = toWindow(query.window)

  return {
    windowMs,
    facets: useMonitorStore().facetCounts({
      since: Date.now() - windowMs,
      filter: parseFacetFilter(query),
    }),
  }
})
