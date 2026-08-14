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

  /**
   * The chart starts at the deploy before the issue, not at the issue.
   *
   * "Did this start after a release" is the question, and it cannot be
   * answered by a line that begins at the first error: the interesting half of
   * the shape — quiet, then a deploy, then errors — is entirely to the left of
   * that. Drawn from the preceding release instead, so the flat stretch is on
   * the canvas and the marker has something to divide.
   *
   * Only under an unfiltered view. A filter narrows which occurrences exist,
   * so the run-up would be quiet for a reason that has nothing to do with the
   * deploy — it would be quiet because those events were filtered out.
   */
  const before = Object.keys(filter).length
    ? undefined
    : await store.deployBefore(issue.firstSeen)

  const trend = await store.issueTrend(fingerprint, filter, before?.at)

  // Drawn on the issue's own chart, so bounded by that chart's axis. "Did the
  // release fix this or cause it" is a question about the shape either side of
  // a moment, and the header's list of release names cannot answer it: that an
  // issue spans 1.8.2 to 1.8.4 does not say it stopped when the last one
  // shipped. Skipped entirely when there is no line to draw them on.
  //
  // The end of the axis is the last bucket's start *plus its width*, not the
  // start alone. A point's `at` labels the beginning of a bucket up to `step`
  // wide, so bounding by it blinds the chart to everything in the final
  // bucket — on a week-long issue that is a four-hour hole at the right-hand
  // edge, and the deploy it hides is the most recent one, which is the one
  // anybody opened the page to ask about.
  const deploys = trend.points.length > 1
    ? await store.deploysBetween(
        trend.points[0]!.at,
        trend.points[trend.points.length - 1]!.at + trend.step,
      )
    : []

  return {
    issue,
    facets: await store.facetCounts({
      fingerprint,
      filter,
      limit: facetLimit(getQuery(event).limit),
    }),
    sessionCount: await store.sessionCount(fingerprint, filter),
    // The count above with a denominator. Absent for a server-side issue,
    // where sessions do not apply at all.
    sessionShare: await store.sessionShare(fingerprint, filter),
    // What the breakdown is a breakdown of — see `eventCount`.
    eventCount: await store.eventCount(fingerprint, filter),
    trend,
    deploys,
    // Unfiltered on purpose: "introduced in 1.8.2" is a fact about the issue,
    // and narrowing to one browser would answer "introduced in 1.8.2 *for
    // Firefox users*" under a heading that does not say so.
    releases: await store.issueReleases(fingerprint),
    /**
     * The other errors from the same request as the newest occurrence.
     *
     * One failing request usually produces two rows on two different screens:
     * the endpoint's 500 under server errors, and the browser's "Cannot read
     * properties of undefined" under client errors, thrown by the component
     * that received the failure. They are one incident, and reading them as
     * two is how an afternoon goes into debugging the symptom.
     *
     * Taken from the newest occurrence rather than every one of them: an issue
     * that happened four hundred times has four hundred request ids, and the
     * union of everything that ever co-occurred with it is not a finding — it
     * is the whole database. One request is a story.
     */
    related: await relatedFor(store, resolved[0], fingerprint),
    events: resolved,
  }
})

/** Nothing to relate when the occurrence carried no correlation id. */
async function relatedFor(
  store: Awaited<ReturnType<typeof useMonitorStore>>,
  newest: { context?: Record<string, unknown> } | undefined,
  fingerprint: string,
): Promise<Awaited<ReturnType<typeof store.relatedByRequest>>> {
  const id = newest?.context?.requestId

  return typeof id === 'string' && id ? store.relatedByRequest(id, fingerprint) : []
}
