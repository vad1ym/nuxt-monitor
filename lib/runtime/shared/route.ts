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
/**
 * Development tooling that serves itself over the application's own port.
 *
 * Nuxt DevTools answers on `/__nuxt_devtools__` and polls constantly, so
 * without this it lands in "busiest endpoints" and "slowest endpoints" and
 * pushes the application's own routes off both. That was always true; opening
 * the dashboard as a DevTools tab is what made it obvious, because the panel
 * then shows its own traffic back to the reader as though it were the app's.
 *
 * Excluded outright rather than merely ranked lower: this is not the
 * application, so every number here — including the request count that error
 * rates are divided by — is more honest without it.
 */
export function isToolingRoute(path: string | undefined): boolean {
  if (!path) {
    return false
  }

  return path.startsWith('/__nuxt_devtools__') || path.startsWith('/__nuxt_island')
}

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

/**
 * Which status classes count as the application failing.
 *
 * `4xx` is in the list, and that is the whole point of the list existing.
 * Backends do not follow the conventions: plenty answer 400 or 422 for "your
 * own frontend sent something impossible", which is a bug on the page, not a
 * caller mistake — the same reasoning that put the 4xx range back into
 * `ignore.ts`. Counting only 5xx meant the issue list showed a 422 as a
 * problem while the error rate beside it read 0%, two numbers on one screen
 * disagreeing about whether anything was wrong.
 *
 * `unknown` is excluded: it is a status outside 100–599, which is a
 * bookkeeping artefact rather than a response anybody received.
 */
export const FAILED_CLASSES = ['4xx', '5xx']

/**
 * The counted statuses that are *not* the application's fault.
 *
 * Mirrors `ignore.ts`'s defaults, and for the same reasons: a 404 is a stale
 * link or a scanner, a 429 is the rate limiter doing its job. Neither is
 * recorded as an issue, so counting them as failures would make the rate
 * disagree with the list it sits above — the exact fault this is fixing.
 */
export const EXCUSED_STATUSES = [404, 429]

/**
 * The class a request is counted under.
 *
 * Excused statuses get a class of their own instead of joining `4xx`, because
 * the counter table stores the class and not the status — once a 404 and a 422
 * are both `4xx` in the same row, no read-time query can tell them apart
 * again, and now that 4xx counts as a failure that difference is the whole
 * question. Bucketing them apart at write time is the only place the
 * information still exists.
 *
 * A named class rather than dropping the row: these still belong in the
 * denominator. A 404 is a request the application served, and served
 * correctly; deleting it would shrink the total and inflate the very rate this
 * is meant to keep honest.
 *
 * Rows written before this change keep counting excused statuses as `4xx`, so
 * a database that predates it reads slightly pessimistically for one retention
 * window and then corrects itself. Not migrated: rewriting historical counters
 * to a definition they were not recorded under is a worse lie than a week of
 * knowing they are approximate.
 */
export function countedClass(status: number): string {
  return EXCUSED_STATUSES.includes(status) ? 'excused' : statusClass(status)
}

/**
 * SQL summing the requests that failed, for a query grouping `request_stats`.
 *
 * A fragment rather than eight copies of `CASE WHEN class = '5xx'`. There were
 * eight, spread over the overview, the route table, the traffic page, the
 * uptime strip and the alert trigger, and they are why the definition could
 * drift in the first place: changing what "failed" means is one edit here or
 * eight edits done consistently, and the second kind never stays consistent.
 *
 * Literal rather than parameterised because it is interpolated into `SELECT`
 * lists and `HAVING` clauses where placeholders would have to be threaded
 * through every caller's bind list in the right order. The values are
 * module-level constants, never user input.
 */
export const FAILED_SUM = `COALESCE(SUM(CASE WHEN class IN (${
  FAILED_CLASSES.map(name => `'${name}'`).join(', ')
}) THEN count END), 0)`

/** Whether a status class is one the rate treats as a failure. */
export function isFailedClass(value: string): boolean {
  return FAILED_CLASSES.includes(value)
}

/** Start of the bucket a timestamp belongs to. */
export function bucketOf(timestamp: number, bucketMs: number): number {
  return Math.floor(timestamp / bucketMs) * bucketMs
}
