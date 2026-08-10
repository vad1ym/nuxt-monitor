import { defineEventHandler, getQuery } from '#imports'
import { requireDashboardAccess, useMonitorStore } from '../context'
import { toWindow } from './window'

/**
 * The standalone dashboard sections: releases, routes, environments, sessions.
 *
 * One endpoint rather than four. They are read together when a section opens
 * and they all describe the same window, so splitting them would mean four
 * round trips and four chances for the numbers on one screen to disagree about
 * which instant they describe.
 *
 * `section` narrows the work when only one is needed; without it everything
 * comes back.
 */
export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const query = getQuery(event)
  const windowMs = toWindow(query.window)
  const since = Date.now() - windowMs
  const section = typeof query.section === 'string' ? query.section : undefined

  const store = await useMonitorStore()
  const wants = (name: string): boolean => !section || section === name

  // Awaited rather than handed over as promises: these go into an object,
  // and a pending promise in a response body serialises as `{}` rather than
  // failing — the kind of break that reaches production looking like no data.
  return {
    windowMs,
    releases: wants('releases') ? await store.releases() : undefined,
    routes: wants('routes') ? await store.routes(since) : undefined,
    sessions: wants('sessions') ? await store.sessions(since) : undefined,
    // Environments are the facet counts over the window — the same data the
    // filter panel uses, read as a screen rather than as a control.
    environments: wants('environments') ? await store.facetCounts({ since }) : undefined,
  }
})
