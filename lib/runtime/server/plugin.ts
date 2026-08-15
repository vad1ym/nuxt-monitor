import type { H3Event } from 'h3'
import { defineNitroPlugin, getRequestHeader, getRequestHeaders, getResponseHeader, getResponseStatus, setResponseHeader } from '#imports'
import type { MonitorEvent, MonitorFacets } from '../../types'
import { isAssetPath, routeKind } from '../shared/route'
import { captureBodies, snapshotRequestBody } from './bodies'
import { scrub, scrubUrl } from '../shared/scrub'
import { parseUserAgent } from '../shared/user-agent'
import type { MonitorRuntimeConfig } from './context'
import { captureSync, closeMonitorStore, countLatencySync, countRequestSync, countTrafficSync, monitorConfig } from './context'
import { markRequestId, requestId } from './request-id'
import { statusOf } from './status'
import { describeRuntime } from './runtime-versions'
import { markRequestStart, requestDuration } from './timing'

/**
 * Server-side collection.
 *
 * Every server error path in Nitro funnels through `captureError`, which
 * dispatches this one hook — request and response handlers, plugins, cached
 * function failures, and the process-level `unhandledRejection` /
 * `uncaughtException` traps. One subscription covers all of them.
 */
export default defineNitroPlugin((nitroApp) => {
  const config = monitorConfig()

  /**
   * Starts the clock and settles the correlation id on every request.
   *
   * Unconditional and about as cheap as a hook gets — one `Date.now()`, one
   * header read and two property writes — because there is no way to know at
   * this point which requests are going to fail, and both have to be decided
   * before the one that does. Nothing is stored for a request that succeeds.
   */
  nitroApp.hooks.hook('request', (event: H3Event) => {
    try {
      if (!isMonitorRoute(event, config.route)) {
        markRequestStart(event)
        markRequestId(event, getRequestHeaders(event))
      }
    }
    catch {
      // Bookkeeping must never interfere with serving.
    }
  })

  /**
   * Snapshots the request body while the request is still in hand.
   *
   * `beforeResponse` fires for a failing request too, and before the error is
   * dispatched — which is the whole reason it is done here rather than read
   * back inside the error hook, where the event is not reliably carrying the
   * same `node.req` the handler parsed from. Does nothing at all unless
   * `capture.request` is on.
   */
  nitroApp.hooks.hook('beforeResponse', (event: H3Event) => {
    try {
      if (!isMonitorRoute(event, config.route)) {
        snapshotRequestBody(event, config.capture)
        echoRequestId(event)
      }
    }
    catch {
      // Never let a snapshot interfere with serving a response.
    }
  })

  nitroApp.hooks.hook('error', (error: Error, context: { event?: H3Event, tags?: string[] }) => {
    try {
      // The dashboard's own failures must not be reported into the dashboard:
      // a broken store would otherwise feed itself.
      if (context.event && isMonitorRoute(context.event, config.route)) {
        return
      }

      // Counted here as well as in `afterResponse`, because a thrown request
      // never reaches that hook: h3 runs `onError` and returns, so the
      // failures — the only ones the rate is about — would all be missing
      // from the denominator.
      if (context.event) {
        countOnce(context.event, statusOf(error, getResponseStatus(context.event)))

        // And the correlation id, for the same reason and with worse
        // consequences. `beforeResponse` is skipped by a thrown request, so
        // setting the header only there put it on every response except the
        // failing ones — precisely the responses whose id is worth having.
        // Verified against a running server: a 200 carried the header and a
        // 500 did not.
        echoRequestId(context.event)
      }

      if (isDuplicate(error, context.event)) {
        return
      }

      // Synchronous by design: the hook runs while the response is being
      // produced, so opening the database must never be awaited here.
      captureSync(toEvent(error, context, config))
    }
    catch {
      // Capture must never add a second failure to the one being reported.
    }
  })

  /**
   * Counts every finished request.
   *
   * An error count on its own says nothing about severity: ten failures out of
   * ten requests and ten out of a million are different situations. Successes
   * are recorded as counters only — a route shape, a method and a status
   * class — never bodies, headers or addresses.
   */
  nitroApp.hooks.hook('afterResponse', (event: H3Event) => {
    try {
      if (isMonitorRoute(event, config.route)) {
        return
      }

      countOnce(event, getResponseStatus(event) || 200)
    }
    catch {
      // Counting must never interfere with serving.
    }
  })

  /**
   * Shutdown.
   *
   * Flushing alone leaves the SQLite handle open and both timers scheduled,
   * which a long-running process never notices but a dev server reloading on
   * every edit certainly does — one leaked connection and one leaked interval
   * per reload. `closeMonitorStore` flushes first, so nothing buffered is lost.
   */
  nitroApp.hooks.hook('close', async () => {
    try {
      await closeMonitorStore()
    }
    catch {
      // Shutdown is not a place to throw.
    }
  })
})

/**
 * Whether a request belongs to the dashboard, which is excluded from
 * collection so a broken store cannot feed itself.
 *
 * The boundary has to be a path segment. A plain prefix match also swallowed
 * `/_monitoring` and `/_monitor-marketing`, quietly dropping every error from a
 * route that only happened to start with the same letters.
 */
function isMonitorRoute(event: H3Event, route: string): boolean {
  const path = event.path ?? ''

  if (!path.startsWith(route)) {
    return false
  }

  const next = path[route.length]

  return next === undefined || next === '/' || next === '?'
}

/**
 * Counts a request exactly once.
 *
 * Both hooks can fire for one request — an error inside `beforeResponse`, for
 * instance — and counting twice would quietly inflate the denominator that
 * every rate on the overview is divided by.
 *
 * Static assets are not counted at all. They are not endpoints, so they cannot
 * fail in a way anybody acts on, and one page view drags thirty chunks in with
 * it — enough to make a broken endpoint read as healthy purely by dilution.
 */
function countOnce(event: H3Event, status: number): void {
  const state = event.context as { _monitorCounted?: boolean }

  if (state._monitorCounted) {
    return
  }

  state._monitorCounted = true

  const path = event.path ?? '/'

  if (isAssetPath(path)) {
    return
  }

  countRequestSync(path, event.method ?? 'GET', status)

  // How long it took, whether or not it worked.
  //
  // The one measurement here that is not about an error, and the one that
  // lets this see a fault that never throws: an endpoint answering 200 in
  // eight seconds produced no issue, no error rate and no sign at all, while
  // being the thing that made the application unusable.
  const elapsed = requestDuration(event)

  if (elapsed !== undefined) {
    countLatencySync(path, elapsed)
  }

  // The same request, counted a second way: which browser and device it came
  // from, and which page they asked for. The first turns "90% of these errors
  // are on iOS" into a finding or a tautology — without a traffic baseline the
  // sentence only restates the shape of the audience. The second says which
  // pages the traffic is actually on, which is what ranks them for testing and
  // tells you what a break would cost.
  //
  // Pages only. A page view drags a dozen `$fetch` calls behind it, and
  // counting those would weight one visitor by how chatty the page is rather
  // than by their being one visitor — and would bury the pages themselves
  // under the endpoints they call.
  if (routeKind(path, getRequestHeader(event, 'accept')) === 'page') {
    countTrafficSync(parseUserAgent(getRequestHeader(event, 'user-agent')), path)
  }
}

/**
 * Puts the correlation id on the response, so the browser can quote it back.
 *
 * This is what closes the loop across the two sides. A failing endpoint and
 * the component that broke on its answer are one incident, and until the
 * browser knows the id there is nothing to join them by — the client error
 * arrives with a URL and a timestamp, which during an incident matches forty
 * other requests in the same second.
 *
 * `x-request-id` rather than a name of our own, because the value is very
 * often not ours: it is adopted from whatever the proxy in front already set,
 * and echoing it under the conventional name is what lets it match the access
 * log too. Set rather than overwritten only when absent — a proxy that sets
 * its own on the way out should win, since that is the one in its log.
 */
function echoRequestId(event: H3Event): void {
  const id = requestId(event)

  if (id && !getResponseHeader(event, 'x-request-id')) {
    setResponseHeader(event, 'x-request-id', id)
  }
}

/**
 * The error's constructor name, recovered from the stack when necessary.
 *
 * h3 rewraps a thrown error in an `H3Error` before it reaches this hook, so
 * `error.name` reads `Error` even when a `TypeError` was thrown. The first
 * stack line still begins with the original name, and keeping it matters:
 * `TypeError` versus `Error` is a real distinction when reading a report, and
 * it feeds into how issues are grouped.
 */
function errorType(error: Error): string {
  const name = error?.name

  if (name && name !== 'Error' && name !== 'H3Error') {
    return name
  }

  // "TypeError: Cannot read properties of null" → "TypeError"
  const header = error?.stack?.split('\n')[0] ?? ''
  const match = /^([A-Za-z_$][\w$]*(?:Error|Exception))\s*:/.exec(header.trim())

  return match?.[1] ?? name ?? 'Error'
}

/**
 * Recognises a fault already reported earlier in the same request.
 *
 * A render failure reaches this hook twice: once from Nuxt's `vue:error`
 * bridge and again when the error propagates out of the handler. The two are
 * not the same object — Nuxt wraps the original in an `H3Error`, which also
 * loses the constructor name — so identity and the fingerprint both miss it.
 * The stack survives the wrapping unchanged, and within one request it
 * identifies the fault precisely.
 */
function isDuplicate(error: Error, event: H3Event | undefined): boolean {
  const stack = error?.stack

  // Without a stack there is nothing dependable to compare.
  if (!event || !stack) {
    return false
  }

  const store = (event.context as { _monitorSeen?: Set<string> })._monitorSeen ??= new Set()

  // The head carries the message and the throw site, which is what differs
  // between genuinely distinct faults.
  const key = stack.split('\n').slice(0, 3).join('\n')

  if (store.has(key)) {
    return true
  }

  store.add(key)

  return false
}

function toEvent(
  error: Error,
  context: { event?: H3Event, tags?: string[] },
  config: MonitorRuntimeConfig,
): MonitorEvent {
  const event = context.event

  return {
    side: 'server',
    type: errorType(error),
    message: error?.message || String(error),
    stack: error?.stack,
    timestamp: Date.now(),
    tags: context.tags,
    // Classified here, where the request is still in hand: the `Accept` header
    // is the one reliable signal for an app that does not mount its endpoints
    // under `/api`, and it is gone by the time anything reads the row back.
    kind: event ? routeKind(event.path, getRequestHeader(event, 'accept')) : undefined,
    context: event ? requestContext(event, error, config) : undefined,
    facets: serverFacets(event, config.release),
  }
}

/**
 * Facets for a server error.
 *
 * The browser fields describe whoever made the request — a server error on a
 * page render still happened *to* somebody, and knowing it only breaks on one
 * browser is as useful here as it is on the client. There is no session id:
 * `sessionStorage` is a browser thing, and inventing a server-side equivalent
 * would mean issuing an identifier, which is exactly what this design avoids.
 */
function serverFacets(event: H3Event | undefined, release: string): MonitorFacets | undefined {
  if (!event) {
    return release ? { release } : undefined
  }

  const parsed = parseUserAgent(getRequestHeader(event, 'user-agent'))

  return {
    browser: parsed.browser,
    browserVersion: parsed.browserVersion,
    os: parsed.os,
    osVersion: parsed.osVersion,
    deviceType: parsed.deviceType,
    release: release || undefined,
  }
}

/**
 * Request details worth having when reading the error later.
 *
 * The H3Event rides along in the error context, so this needs no separate
 * request hook and no per-request bookkeeping.
 */
function requestContext(
  event: H3Event,
  error: Error,
  config: MonitorRuntimeConfig,
): Record<string, unknown> {
  const options = { extraKeys: config.scrubKeys }

  const context: Record<string, unknown> = {
    url: scrubUrl(event.path ?? '', options),
    method: event.method,
    headers: scrub(getRequestHeaders(event), options),
  }

  // What the *visitor* got, not what an inner call reported.
  //
  // `createError({ statusCode })` is the normal way to signal an HTTP failure
  // and its code is the first thing anybody wants to see — but a `FetchError`
  // from the page's own `$fetch` carries the upstream API's status instead.
  // Reading it blindly attributed a page that died with 500 in the browser to
  // whatever the inner request happened to answer, and the ignore rules then
  // filtered on that borrowed number: a crashed render disappeared behind a
  // 404 or a 422 that was never sent to anyone.
  context.statusCode = statusOf(error, getResponseStatus(event))

  // How long it had been running. Absent rather than zero when the request
  // never passed the hook that starts the clock — a process-level rejection
  // has no request behind it, and "0 ms" would describe one that failed
  // instantly, which is a different and wrong claim.
  const duration = requestDuration(event)

  if (duration !== undefined) {
    context.durationMs = duration
  }

  // What ties this error to the log lines and the proxy entry for the same
  // request. Absent when the error had no request behind it.
  const correlation = requestId(event)

  if (correlation !== undefined) {
    context.requestId = correlation
  }

  // What it was running on. One string rather than three context rows: these
  // are read together or not at all, and three rows of version numbers would
  // push the fields somebody actually came for off the first screen.
  const runtime = describeRuntime(config.versions)

  if (runtime) {
    context.runtime = runtime
  }

  // What was sent and what came back. The response half used to be stored as
  // an unlabelled `data` key, which is what `createError` calls it — accurate
  // to the API and useless to a reader, who has to know that the field means
  // "the body this request was about to answer with".
  const { requestBody, responseBody } = captureBodies(event, error, config.capture, options)

  if (requestBody !== undefined) {
    context.requestBody = requestBody
  }

  if (responseBody !== undefined) {
    context.responseBody = responseBody
  }

  return context
}
