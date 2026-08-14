import type { H3Event } from 'h3'

/**
 * A correlation id for one request.
 *
 * The thing it is for is joining: this error, the log lines that led to it,
 * and the entry in whatever sits in front of the application. Without one, the
 * only way to line those up is by timestamp, which stops working at exactly
 * the moment it matters — during an incident, when there are forty requests
 * inside the same second and the interesting one is not the first.
 *
 * Deliberately not an identity. It is per-request, never per-user and never
 * per-session: it dies with the response, it is not stored anywhere except on
 * the events of a request that failed, and nothing can be joined across two
 * requests with it. That is the difference between correlation and tracking,
 * and it is the reason this can exist in a module whose selling point is not
 * collecting things about people.
 */

/** Where the id is parked, on the event's own context. */
const REQUEST_ID = '_monitorRequestId'

/**
 * Headers a proxy or load balancer may already have set.
 *
 * Adopted rather than overwritten, in this order, because the point of the
 * value is to match something outside this process. Generating our own while
 * nginx or Cloudflare puts a different one in its access log gives the reader
 * two ids for one request and no way to tell that they are the same request —
 * strictly worse than having none, because it looks like it should work.
 */
const INBOUND = [
  'x-request-id',
  'x-correlation-id',
  'x-amzn-trace-id',
  'cf-ray',
]

/**
 * The longest an adopted id may be.
 *
 * Bounded because this comes off the wire: the header is written by whoever is
 * making the request, and an unbounded one would be a free column of arbitrary
 * text on every stored error.
 */
const MAX_LENGTH = 200

/** Short enough to store on every event, wide enough not to collide. */
function newId(): string {
  const random = globalThis.crypto?.randomUUID?.()

  if (random) {
    return random.replace(/-/g, '').slice(0, 16)
  }

  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

/**
 * Adopts an inbound id or makes one, once per request.
 *
 * Idempotent: called again for the same event it returns what it already
 * decided, so a retry of the hook cannot give one request two identities.
 */
export function markRequestId(event: H3Event, headers: Record<string, string | undefined>): string {
  const context = event.context as Record<string, unknown>
  const existing = context[REQUEST_ID]

  if (typeof existing === 'string') {
    return existing
  }

  const inbound = INBOUND
    .map(name => headers[name])
    .find(value => typeof value === 'string' && value.trim().length > 0)

  const id = inbound ? inbound.trim().slice(0, MAX_LENGTH) : newId()
  context[REQUEST_ID] = id

  return id
}

/**
 * The id of a request, if one was marked.
 *
 * Undefined for an error with no request behind it — an `unhandledRejection`
 * in a timer belongs to no request, and inventing an id for it would promise a
 * correlation that leads nowhere.
 */
export function requestId(event: H3Event | undefined): string | undefined {
  const value = (event?.context as Record<string, unknown> | undefined)?.[REQUEST_ID]

  return typeof value === 'string' ? value : undefined
}
