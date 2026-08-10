import { defineNuxtPlugin, useRuntimeConfig } from '#imports'
import type { MonitorBreadcrumb } from '../../types'
import type { ClientEvent } from './queue'
import { EventQueue } from './queue'
import { sessionId } from './session'

/**
 * Browser-side collection.
 *
 * Four sources are needed, not one. Nuxt installs its own Vue error handler
 * and then removes it once the app hydrates, so `app:error` covers startup and
 * `showError()` but goes quiet afterwards; `vue:error` carries component
 * errors for the rest of the session; and neither sees plain `window` errors
 * or unhandled rejections. The queue collapses the overlap.
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

    const queue = new EventQueue({
      send: events => post(endpoint, events),
    })

    const record = (crumb: MonitorBreadcrumb): void => {
      breadcrumbs.push(crumb)

      if (breadcrumbs.length > MAX_BREADCRUMBS) {
        breadcrumbs.shift()
      }
    }

    const capture = (error: unknown, extra: Record<string, unknown> = {}): void => {
      const normalized = toClientEvent(error, extra, breadcrumbs)

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
  },
})

/**
 * `sendBeacon` survives page unload, which is exactly when the last errors
 * tend to happen. It refuses oversized payloads, so fall back to `fetch`.
 */
function post(endpoint: string, events: ClientEvent[]): boolean {
  const body = JSON.stringify({ events })

  try {
    if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'application/json' }))) {
      return true
    }

    void fetch(endpoint, {
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
