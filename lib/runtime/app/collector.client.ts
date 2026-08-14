import { defineNuxtPlugin, useRuntimeConfig } from '#imports'
import type { MonitorBreadcrumb } from '../../types'
import type { ClientEvent } from './queue'
import { EventQueue } from './queue'
import { sessionId } from './session'

/**
 * The browser's own `fetch`, kept before anything wraps it.
 *
 * Taken at module scope so the reporter below can use it too. Sending reports
 * through the wrapper would mean the batch that reports an error becomes a
 * breadcrumb on the next one, and a failing intake would feed itself — the
 * same self-reference the server side avoids by excluding its own route.
 *
 * Also insurance against another tool wrapping `fetch` after us: whatever the
 * application installs later, reports still go out through the real one.
 */
const originalFetch = globalThis.fetch?.bind(globalThis)

/**
 * Browser-side collection.
 *
 * Four sources are needed, not one. Nuxt installs its own Vue error handler
 * and then removes it once the app hydrates, so `app:error` covers startup and
 * `showError()` but goes quiet afterwards; `vue:error` carries component
 * errors for the rest of the session; and neither sees plain `window` errors
 * or unhandled rejections. The queue collapses the overlap.
 *
 * Alongside them it keeps a short trail of what led up to the error —
 * navigations, requests and clicks. That trail is most of what makes a browser
 * error diagnosable: the component that threw is rarely where the problem
 * started, and the request that returned the unexpected shape usually is.
 */
export default defineNuxtPlugin({
  name: 'monitor:collector',
  // Errors thrown by other plugins should be caught, so install first.
  enforce: 'pre',

  setup(nuxtApp) {
    const config = useRuntimeConfig().public.monitor as { route: string, release?: string } | undefined
    const route = config?.route ?? '/_monitor'
    const endpoint = `${route}/api/ingest`
    const release = config?.release || undefined

    const breadcrumbs: MonitorBreadcrumb[] = []
    const MAX_BREADCRUMBS = 30

    /**
     * The id of the most recent request that failed, if the server sent one.
     *
     * What lets a browser error be joined to the endpoint failure behind it.
     * Held in one variable rather than per request because the error being
     * reported has no reference to any particular fetch — it is thrown by a
     * component reacting to one — so the only available link is "the request
     * that just failed".
     */
    let lastFailedRequestId: string | undefined

    const queue = new EventQueue({
      send: events => post(endpoint, events, sessionId()),
    })

    /**
     * Says "a session exists", once, so client error counts have a denominator.
     *
     * Without it the server hears from a browser only when something has
     * already gone wrong, which means the dashboard has a numerator and no
     * total: "5 sessions saw an error" is an outage out of 20 sessions and
     * noise out of 200,000, and nothing on the screen could tell them apart.
     *
     * Sent once per page load rather than per navigation. A single-page app
     * changes route without reloading, and counting those would measure how
     * much somebody browsed rather than that they were here — the same
     * reasoning that keeps `$fetch` calls out of the server's page counter.
     * The server de-duplicates per bucket anyway, so a repeat is harmless.
     *
     * Deliberately not awaited and deliberately ignored on failure: this is a
     * denominator, and no page should be slower or noisier because a counter
     * did not arrive.
     */
    post(endpoint, [], sessionId())

    const record = (crumb: MonitorBreadcrumb): void => {
      breadcrumbs.push(crumb)

      if (breadcrumbs.length > MAX_BREADCRUMBS) {
        breadcrumbs.shift()
      }
    }

    const capture = (error: unknown, extra: Record<string, unknown> = {}): void => {
      const normalized = toClientEvent(
        error,
        // Carried so the two halves of one incident can be read as one: the
        // endpoint's 500 and the component that broke on its answer.
        lastFailedRequestId ? { ...extra, requestId: lastFailedRequestId } : extra,
        breadcrumbs,
      )

      if (normalized) {
        // Browser and OS are not sent from here: the request carries a
        // `User-Agent` header anyway, and parsing it on the server keeps the
        // parser — and its size — out of the application bundle.
        normalized.facets = { session: sessionId(), release }
        queue.add(normalized)
      }
    }

    // Component errors, for the whole session.
    nuxtApp.hook('vue:error', (error, _instance, info) => {
      capture(error, { source: 'vue:error', info })
    })

    // Startup failures and `showError()`.
    nuxtApp.hook('app:error', (error) => {
      capture(error, { source: 'app:error' })
    })

    // Everything outside Vue: event handlers, timers, third-party scripts.
    window.addEventListener('error', (event) => {
      // Resource load failures carry no Error and a different shape.
      if (!event.error && event.target && event.target !== window) {
        const target = event.target as HTMLElement & { src?: string, href?: string }

        record({
          type: 'console',
          timestamp: Date.now(),
          message: `Failed to load ${target.tagName?.toLowerCase()}: ${target.src || target.href || ''}`,
        })
        return
      }

      capture(event.error ?? event.message, {
        source: 'window.onerror',
        file: event.filename,
        line: event.lineno,
        column: event.colno,
      })
    })

    window.addEventListener('unhandledrejection', (event) => {
      capture(event.reason, { source: 'unhandledrejection' })
    })

    // Navigation history, which is most of the value of breadcrumbs.
    nuxtApp.hook('page:start', () => {
      record({
        type: 'navigation',
        timestamp: Date.now(),
        message: window.location.pathname + window.location.search,
      })
    })

    /**
     * Requests, which is where the other half of the value is.
     *
     * A client error almost never starts in the component that threw — it
     * starts in the call that returned something the component did not expect.
     * "Cannot read properties of undefined" with a `GET /api/cart → 500` two
     * seconds before it is a solved bug; the same message alone is an hour of
     * somebody's afternoon.
     *
     * `fetch` is wrapped rather than hooked, because `$fetch`, `useFetch` and
     * a plain `fetch` in somebody's composable all end up here, and wrapping
     * one of the three would quietly miss the others.
     */
    window.fetch = async function monitored(...args: Parameters<typeof fetch>) {
      const started = Date.now()
      const request = args[0]
      const url = typeof request === 'string'
        ? request
        : request instanceof URL ? request.href : request.url
      const method = (args[1]?.method
        ?? (request instanceof Request ? request.method : 'GET')).toUpperCase()

      // The monitor's own intake must never appear in its own breadcrumbs: the
      // batch that reports an error would otherwise become a crumb on the next
      // one, and a failing intake would feed itself.
      const ours = typeof url === 'string' && url.includes(endpoint)

      try {
        const response = await originalFetch(...args)

        if (!ours) {
          /**
           * The correlation id the server put on the response.
           *
           * Remembered only for failing responses, and only until the next
           * one. A component that breaks on a bad payload throws within a tick
           * or two of receiving it, so the most recent failure is very nearly
           * always the one that caused the error being reported — and when it
           * is not, the worst case is a link to a request that also failed a
           * moment earlier, which is still the right neighbourhood.
           *
           * Successful responses deliberately do not overwrite it: the whole
           * value is joining a browser error to the request that broke it, and
           * a page firing analytics between the failure and the throw would
           * otherwise erase the only useful id.
           */
          if (response.status >= 400) {
            lastFailedRequestId = response.headers.get('x-request-id') ?? lastFailedRequestId
          }

          record({
            type: 'fetch',
            timestamp: started,
            message: `${method} ${strip(url)} → ${response.status}`,
            data: { status: response.status, ms: Date.now() - started },
          })
        }

        return response
      }
      catch (failure) {
        if (!ours) {
          // A request that never got a response at all — offline, DNS, CORS.
          // The most useful crumb of the lot, and the one a status-code-only
          // record would miss entirely.
          record({
            type: 'fetch',
            timestamp: started,
            message: `${method} ${strip(url)} → failed`,
            data: { ms: Date.now() - started },
          })
        }

        throw failure
      }
    } as typeof fetch

    /**
     * What was clicked, which is how a person describes what they did.
     *
     * Captured passively and cheaply: the element's own text, trimmed hard.
     * No values, no input contents, no attributes — a breadcrumb trail is not
     * a session recording, and the label on a button is enough to retrace the
     * step without collecting anything about the person who pressed it.
     */
    document.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest('button, a, [role="button"]')

      if (!target) {
        return
      }

      const label = (target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)

      record({
        type: 'click',
        timestamp: Date.now(),
        message: label || target.tagName.toLowerCase(),
      })
    }, { capture: true, passive: true })

    // A pending batch would be lost when the tab goes away. `visibilitychange`
    // fires reliably on mobile, where `beforeunload` often does not.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        queue.flush()
      }
    })

    window.addEventListener('pagehide', () => queue.flush())

    // Otherwise a lone error waits for a batch that may never fill.
    setInterval(() => queue.flush(), 5_000)

    return {
      provide: {
        /**
         * The intake `useMonitor().exception()` reports through.
         *
         * Exposed rather than re-created in the composable so a manual report
         * takes exactly the path a caught error does: the same queue, the same
         * de-duplication, the same rate limit and the same breadcrumbs. A
         * second sender would be a second set of those, and the rate limit in
         * particular exists to survive a loop — a loop calling `exception()`
         * is no less a loop.
         */
        monitorReport: (event: ClientEvent): void => {
          event.facets = { session: sessionId(), release }
          event.breadcrumbs ??= breadcrumbs.slice()
          queue.add(event)
        },
      },
    }
  },
})

/**
 * A URL short enough to read and stripped of its query.
 *
 * The query is dropped outright rather than redacted key by key. The server
 * scrubs these on the way in as well, but a breadcrumb is a place where a
 * token is pure noise — nobody debugging "which call preceded the error" needs
 * the parameters, and the safest handling of a value you do not need is not to
 * send it.
 */
function strip(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url

  // Same-origin calls are the common case and the origin is repeated noise.
  const path = withoutQuery.startsWith(window.location.origin)
    ? withoutQuery.slice(window.location.origin.length)
    : withoutQuery

  return path.length > 120 ? `${path.slice(0, 120)}…` : path
}

/**
 * `sendBeacon` survives page unload, which is exactly when the last errors
 * tend to happen. It refuses oversized payloads, so fall back to `fetch`.
 */
function post(endpoint: string, events: ClientEvent[], session?: string): boolean {
  // The session rides on every post rather than only the first. It is what the
  // server counts as one visitor, and a batch that arrives after a page load
  // whose hello was lost — offline at the time, a beacon refused — would
  // otherwise be an error from a session that, as far as the totals are
  // concerned, never existed.
  const body = JSON.stringify({ events, session })

  try {
    if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'application/json' }))) {
      return true
    }

    void originalFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {})

    return true
  }
  catch {
    return false
  }
}

/** Normalizes whatever was thrown — it is not always an Error. */
function toClientEvent(
  error: unknown,
  extra: Record<string, unknown>,
  breadcrumbs: MonitorBreadcrumb[],
): ClientEvent | undefined {
  let type = 'Error'
  let message = ''
  let stack: string | undefined

  if (error instanceof Error) {
    type = error.name || 'Error'
    message = error.message
    stack = error.stack
  }
  else if (typeof error === 'string') {
    message = error
  }
  else if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown, message?: unknown, stack?: unknown }

    type = typeof candidate.name === 'string' ? candidate.name : 'Error'
    message = typeof candidate.message === 'string' ? candidate.message : safeStringify(error)
    stack = typeof candidate.stack === 'string' ? candidate.stack : undefined
  }
  else {
    message = String(error)
  }

  if (!message) {
    return undefined
  }

  return {
    type,
    message,
    stack,
    timestamp: Date.now(),
    context: {
      url: window.location.pathname + window.location.search,
      userAgent: navigator.userAgent,
      ...extra,
    },
    breadcrumbs: breadcrumbs.length ? [...breadcrumbs] : undefined,
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 500) ?? String(value)
  }
  catch {
    return String(value)
  }
}
