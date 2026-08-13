import { defineEventHandler, getQuery } from '#imports'
import { requireDashboardAccess, useMonitorStore } from '../context'
import { toWindow } from './window'
import { facetLimit, parseFacetFilter } from '../facets'

/**
 * Facet counts across the whole window.
 *
 * Separate from `/api/issues` because the two answer different questions and
 * change at different rates: the list re-fetches on every keystroke in the
 * search box, while the panel beside it only needs to move when the filter or
 * the window does.
 */
export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const query = getQuery(event)
  const windowMs = toWindow(query.window)
  const store = await useMonitorStore()

  // Only when asked for. The panel does not need a baseline; the one-line
  // summary on an issue does, and fetching it for every filter change would
  // be a second aggregate nobody reads.
  const baseline = query.baseline === 'true' || query.baseline === '1'

  return {
    windowMs,
    /**
     * What the traffic looked like, for judging a breakdown against.
     *
     * Absent unless requested. Undefined and empty mean different things: no
     * baseline was asked for, against no page views were counted — and the
     * second is what makes a skew unjudgeable rather than absent.
     */
    traffic: baseline ? await store.trafficFacets(windowMs) : undefined,
    // Awaited: a pending promise in a response body serialises as `{}`
    // rather than throwing, so the dashboard receives a facet panel with no
    // dimensions and nothing anywhere reports an error.
    facets: await store.facetCounts({
      since: Date.now() - windowMs,
      filter: parseFacetFilter(query),
      // The panel raises this to open up a long list. Clamped in the query, so
      // a hand-written value cannot ask for every distinct route at once.
      limit: facetLimit(query.limit),
    }),
  }
})
