import { defineEventHandler, getQuery } from '#imports'
import { requireDashboardAccess, useMonitorStore } from '../context'
import { toWindow } from './window'

/**
 * What people press, ranked, optionally within one page.
 *
 * The other half of the question the route facet answers. Page views say where
 * the traffic is; this says what it does on arrival, and the pair is what makes
 * "which paths are worth a test" answerable from data rather than from memory:
 * a busy page whose main action is rarely pressed and one where every visitor
 * presses it need different tests, and a ranking of pages alone cannot tell
 * them apart.
 *
 * Its own route rather than a field on the facets response, because it is read
 * at a different moment — after a page has been picked out of the ranking, not
 * alongside it — and folding it in would make every facet fetch pay for an
 * aggregate that is usually not looked at.
 */
export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const query = getQuery(event)
  const windowMs = toWindow(query.window)
  const store = await useMonitorStore()

  // A route narrows this to one page. Passed through as written and normalised
  // by the query, so `/posts/1` finds the counts filed under `/posts/:id`
  // rather than quietly nothing.
  const route = typeof query.route === 'string' && query.route ? query.route : undefined

  return {
    windowMs,
    route,
    interactions: await store.interactions(windowMs, {
      route,
      limit: Number(query.limit) || undefined,
    }),
  }
})
