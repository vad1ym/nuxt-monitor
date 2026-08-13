import { defineEventHandler, getQuery } from '#imports'
import { requireDashboardAccess, useMonitorStore } from '../context'
import { isFacetName, parseFacetFilter } from '../facets'
import { toWindow } from './window'
import type { MonitorFacetName } from '../../../types'

/**
 * The traffic dashboard, in one call.
 *
 * One endpoint rather than one per widget: everything on the screen has to
 * describe the same instant, and six requests are six chances to disagree
 * about which instant that is.
 */
export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const query = getQuery(event)

  return (await useMonitorStore()).dashboard({
    windowMs: toWindow(query.window),
    filter: parseFacetFilter(query),
    facets: parseFacets(query.facets),
  })
})

/**
 * Which dimensions to break down by.
 *
 * Chosen by the screen so the reader can add and remove them, and validated
 * here because the name reaches a column: an unrecognised one is dropped
 * rather than passed on.
 */
function parseFacets(value: unknown): MonitorFacetName[] | undefined {
  const names = typeof value === 'string' ? value.split(',') : []
  const valid = names.map(name => name.trim()).filter(isFacetName)

  return valid.length ? valid.slice(0, 8) : undefined
}
