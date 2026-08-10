import type { H3Event } from 'h3'
import { getRequestHeader } from 'h3'

/**
 * Origin checks, for requests that change something.
 *
 * The session cookie is `SameSite=Lax`, which already blocks the ordinary
 * cross-site form post. It does not cover everything: a sibling subdomain is
 * same-site, so `evil.internal.example.com` can drive a request to
 * `monitor.internal.example.com` and the browser will attach the cookie. On a
 * corporate host with wildcard DNS that is not a hypothetical.
 *
 * So a mutating request must also come from this host.
 */

/**
 * Whether a cross-origin request may change state.
 *
 * Unlike the ingest check, a missing `Origin` is refused rather than allowed.
 * Ingest has to tolerate it — some browsers omit the header on same-origin
 * posts and a lost error report is the cost of being wrong. Here the caller is
 * a dashboard the browser always labels, and being wrong means an attacker's
 * page resolved somebody's issue.
 */
export function hasTrustedOrigin(event: H3Event): boolean {
  const origin = getRequestHeader(event, 'origin')
  const host = getRequestHeader(event, 'host')

  if (!origin || !host) {
    return false
  }

  try {
    return new URL(origin).host === host
  }
  catch {
    return false
  }
}
