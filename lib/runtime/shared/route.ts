import type { MonitorRouteKind } from '../../types'
/**
 * Collapses request paths into route shapes.
 *
 * Counters are kept per route, so the raw path cannot be the key: `/users/1`,
 * `/users/2` and a million more would each become a row, and the table would
 * grow with traffic rather than with the size of the application. Replacing
 * the variable segments gives one row per endpoint, which is what a rate is
 * meaningful over.
 */

const MAX_SEGMENTS = 12
const MAX_LENGTH = 200

/** Segments that are values rather than route structure. */
const PATTERNS: [RegExp, string][] = [
  [/^\d+$/, ':id'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ':uuid'],
  // Mongo-style ids and other long hex runs.
  [/^[0-9a-f]{16,}$/i, ':hash'],
  // Slugs ending in an id: `my-post-1234`.
  [/^[\w-]*-\d{2,}$/, ':slug'],
]

export function normalizeRoute(path: string | undefined): string {
  if (!path) {
    return '/'
  }

  // The query string is per-request detail, not part of the route.
  const [withoutQuery] = path.split('?')
  const trimmed = (withoutQuery ?? '').slice(0, MAX_LENGTH)

  if (!trimmed || trimmed === '/') {
    return '/'
  }

  const segments = trimmed.split('/').filter(Boolean)

  if (segments.length > MAX_SEGMENTS) {
    // Deeper than any real route; collapse the tail rather than keeping an
    // unbounded key.
    return `/${segments.slice(0, MAX_SEGMENTS).map(normalizeSegment).join('/')}/*`
  }

  return `/${segments.map(normalizeSegment).join('/')}`
}

function normalizeSegment(segment: string): string {
  // A file extension marks an asset path, which is structure worth keeping.
  if (/\.[a-z0-9]{1,8}$/i.test(segment)) {
    return normalizeAsset(segment)
  }

  for (const [pattern, replacement] of PATTERNS) {
    if (pattern.test(segment)) {
      return replacement
    }
  }

  // Anything else long and opaque is almost certainly a token or an id.
  return segment.length > 40 ? ':value' : segment
}

/** Keeps the extension, hides the build hash. */
function normalizeAsset(segment: string): string {
  const dot = segment.lastIndexOf('.')
  const name = segment.slice(0, dot)
  const extension = segment.slice(dot)

  // `entry.C2V2OSOE.js` and `entry.6A6825Cy.js` are the same asset.
  const withoutHash = name.replace(/[.-][\w-]{8,}$/, '')

  return `${withoutHash === name ? name : `${withoutHash}.*`}${extension}`
}

/**
 * Whether a path is a static asset rather than an endpoint of the application.
 *
 * Every request the server answers used to become a row, which put
 * `/_nuxt/Cn7cGL6M.js` and `/favicon.ico` beside `/api/checkout` in a table
 * ranked by failure rate — fifteen build chunks burying seven real endpoints.
 * They also inflated the denominator behind the error rate, so a page that
 * loads thirty chunks quietly made a failing endpoint look thirty times
 * healthier.
 *
 * Decided on the path, before normalisation, because that is where the build
 * prefix is still intact.
 */
export function isAssetPath(path: string | undefined): boolean {
  if (!path) {
    return false
  }

  const [withoutQuery = ''] = path.split('?')

  // Nuxt's build output, whatever it holds — chunks, the build manifest, CSS.
  if (withoutQuery.startsWith('/_nuxt/')) {
    return true
  }

  // Anything served as a file: an endpoint is `/api/orders`, not `/logo.svg`.
  // A trailing extension is the honest signal, and it is the same test
  // `normalizeSegment` already uses to recognise an asset segment.
  const last = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1)

  return /\.[a-z0-9]{1,8}$/i.test(last)
}

/**
 * Classifies a request.
 *
 * The path is the weaker signal and the header is the stronger one, so both
 * are used. A browser navigating sends `Accept: text/html`; `$fetch` and a
 * mobile client do not — that holds regardless of where an application chooses
 * to mount its endpoints, which a path convention does not. `/api/` is
 * checked first anyway because it is right far more often than not and is
 * available in places no header is, such as a client-side error carrying only
 * a URL.
 */
export function routeKind(path: string | undefined, accept?: string): MonitorRouteKind {
  if (isAssetPath(path)) {
    return 'asset'
  }

  const [withoutQuery = ''] = (path ?? '').split('?')

  // The convention, and Nuxt's own default for `server/api`.
  if (/^\/(?:api|_?trpc|graphql)(?:\/|$)/i.test(withoutQuery)) {
    return 'api'
  }

  // Nitro's other server routes are endpoints too, whatever they are called.
  if (withoutQuery.startsWith('/_')) {
    return 'api'
  }

  // Then the header. A navigation asks for HTML; a data request does not.
  //
  // With no header at all the path has already had its say and did not look
  // like an endpoint, so this is a page. That is also the common case for a
  // client-side error, where all we ever have is the URL of the page it
  // happened on — and calling those pages is right by construction.
  //
  // `*/*` counts as no header. It is a wildcard, not a preference: curl sends
  // it, so do health checks, uptime probes and a fair number of crawlers, and
  // every one of them was landing in `api` purely because the string does not
  // contain `text/html`. That put page requests in the endpoint bucket — the
  // one distinction this function exists to make.
  if (accept === undefined || accept.trim() === '*/*') {
    return 'page'
  }

  return accept.includes('text/html') ? 'page' : 'api'
}

/** `500` → `5xx`, so counters stay small and read as classes. */
export function statusClass(status: number): string {
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    return 'unknown'
  }

  return `${Math.floor(status / 100)}xx`
}

/** Start of the bucket a timestamp belongs to. */
export function bucketOf(timestamp: number, bucketMs: number): number {
  return Math.floor(timestamp / bucketMs) * bucketMs
}
