import type { H3Event } from 'h3'
import { getRequestHeader } from '#imports'

/**
 * Reading the request as the client actually made it.
 *
 * Behind a reverse proxy — which is most production installs — the request the
 * application receives is not the request the browser sent. The `Host` header
 * is whatever the proxy passes upstream, frequently `localhost:3000`, while the
 * browser addressed `app.example.com`. The scheme is `http` on the inside of a
 * connection the browser made over TLS.
 *
 * That matters here for one reason above all: the ingest route accepts a report
 * only from its own origin, and comparing a public `Origin` against an internal
 * `Host` makes every genuine client error look cross-origin. The failure is
 * silent by design — the route answers `204` and records nothing — so an
 * install behind nginx would collect server errors perfectly and quietly lose
 * every browser one.
 */

/**
 * The host the client addressed.
 *
 * `X-Forwarded-Host` first, because when it is present it is the answer by
 * definition: a proxy sets it precisely because it rewrote `Host`. Only the
 * first entry is taken — a chain of proxies appends, and the leftmost is the
 * one the browser used.
 *
 * Trusted without verification, like `X-Forwarded-For` already is. A caller who
 * can set these headers directly can only make their own reports pass an
 * origin check they could have passed by sending no `Origin` at all; there is
 * nothing here to escalate to.
 */
export function requestHost(event: H3Event): string | undefined {
  const forwarded = getRequestHeader(event, 'x-forwarded-host')

  if (forwarded) {
    return forwarded.split(',')[0]!.trim()
  }

  return getRequestHeader(event, 'host')
}

/**
 * Whether a request came from the page this module is installed in.
 *
 * Compared on host alone, not on the full origin. The scheme is the part a
 * proxy routinely changes — the browser speaks `https` to the proxy and the
 * proxy speaks `http` upstream — and a mismatch there says nothing about
 * whether the request is genuine.
 *
 * An absent `Origin` is not evidence of a cross-origin post: several browsers
 * omit it on same-origin requests, and `sendBeacon` is among the cases where
 * it is inconsistent. Treating absence as hostile would drop reports from the
 * browsers that need reporting most.
 */
export function isSameOrigin(event: H3Event): boolean {
  const origin = getRequestHeader(event, 'origin')

  if (!origin) {
    return true
  }

  const host = requestHost(event)

  if (!host) {
    return false
  }

  try {
    return new URL(origin).host === host
  }
  catch {
    // An unparseable `Origin` is not a same-origin request by any reading.
    return false
  }
}

/**
 * The address the request came from, for rate limiting.
 *
 * Behind a proxy every request arrives from the proxy's own address, so
 * without this the ingest limit would be one shared bucket for the whole
 * internet — either uselessly loose or, on a busy site, a limit everybody
 * trips at once.
 */
export function clientAddress(event: H3Event): string {
  const forwarded = getRequestHeader(event, 'x-forwarded-for')

  if (forwarded) {
    return forwarded.split(',')[0]!.trim()
  }

  return getRequestHeader(event, 'x-real-ip')
    ?? event.node?.req?.socket?.remoteAddress
    ?? 'unknown'
}
