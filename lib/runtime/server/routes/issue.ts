import { createError, defineEventHandler, getQuery, getRouterParam, readBody } from '#imports'
import { monitorConfig, requireDashboardAccess, useMonitorStore } from '../context'
import { facetLimit, parseFacetFilter } from '../facets'
import { hasTrustedOrigin } from '../origin'
import { culpritOfFrames } from '../rows'
import { SourcemapResolver } from '../sourcemap'

/** One resolver per process: it caches parsed maps, which is the costly part. */
let resolver: SourcemapResolver | undefined

function useResolver(): SourcemapResolver {
  if (!resolver) {
    const config = monitorConfig()

    resolver = new SourcemapResolver({
      mapsDir: config.mapsDir,
      serverDir: config.serverDir,
      archiveDir: config.archiveDir,
      baseURL: config.baseURL,
      cdnURL: config.cdnURL,
      // In dev there are no maps on disk; they come back from Vite.
      dev: import.meta.dev,
    })
  }

  return resolver
}

export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const fingerprint = getRouterParam(event, 'fingerprint')

  if (!fingerprint) {
    throw createError({ statusCode: 400, statusMessage: 'Missing fingerprint' })
  }

  const store = await useMonitorStore()
  const issue = await store.getIssue(fingerprint)

  if (!issue) {
    throw createError({ statusCode: 404, statusMessage: 'Unknown issue' })
  }

  if (event.method === 'PATCH') {
    // Cookie auth alone is not enough for a state change: a same-site sibling
    // subdomain can drive one and the browser will attach the session.
    if (!hasTrustedOrigin(event)) {
      throw createError({ statusCode: 403, statusMessage: 'Bad origin' })
    }

    const body = await readBody<{ resolved?: boolean, ignored?: boolean }>(event).catch(() => ({}))

    if (typeof body?.resolved === 'boolean') {
      await store.setResolved(fingerprint, body.resolved)
    }

    if (typeof body?.ignored === 'boolean') {
      await store.setIgnored(fingerprint, body.ignored)
    }

    return await store.getIssue(fingerprint)
  }

  // Clicking a slice in the breakdown narrows the occurrences below it, so the
  // same filter drives both.
  const filter = parseFacetFilter(getQuery(event))
  const events = await store.getEvents(fingerprint, 20, filter)

  // Resolved lazily, here rather than at capture time: an error storm would
  // otherwise turn into a burst of map parsing on the request path.
  const resolved = await Promise.all(events.map(async item => ({
    ...item,
    frames: await useResolver().resolveStackAsync(item.stack, {
      // Client stacks arrive through unauthenticated ingest, so the file
      // they name is an attacker's choice: they may only resolve against the
      // published build assets, never an arbitrary path on disk.
      trusted: issue.side === 'server',
      // Each occurrence resolves against the build it came from, so a trace
      // from a release that has since been replaced still points at source.
      release: item.facets?.release,
    }),
  })))

  // The list showed the built file until now, because that is all capture
  // could afford. The frames for the newest occurrence have just been
  // resolved anyway, so the better name is free here — and stored, so the
  // list and the search box get it too, not only this response.
  //
  // Only from an unnarrowed view. Under a facet filter `events` holds the
  // newest occurrence *matching that filter*, and writing its location would
  // let clicking "Firefox" in the breakdown rewrite the name the issue carries
  // for everyone — a stored value quietly deciding itself from a filter the
  // next reader never applied.
  if (!Object.keys(filter).length) {
    const culprit = culpritOfFrames(resolved[0]?.frames ?? [])

    if (culprit && culprit !== issue.culprit) {
      await store.setCulprit(fingerprint, culprit)
      issue.culprit = culprit
    }
  }

  return {
    issue,
    facets: await store.facetCounts({
      fingerprint,
      filter,
      limit: facetLimit(getQuery(event).limit),
    }),
    sessionCount: await store.sessionCount(fingerprint, filter),
    // What the breakdown is a breakdown of — see `eventCount`.
    eventCount: await store.eventCount(fingerprint, filter),
    trend: await store.issueTrend(fingerprint, filter),
    events: resolved,
  }
})
