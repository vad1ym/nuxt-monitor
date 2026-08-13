import type { H3Event } from 'h3'
import { defineEventHandler, getRequestHeader, readRawBody, setResponseStatus } from '#imports'
import type { MonitorBreadcrumb, MonitorEvent, MonitorFacets } from '../../../types'
import { normalizeGroup, normalizeLevel } from '../../shared/exception'
import { routeKind } from '../../shared/route'
import { scrub, scrubUrl } from '../../shared/scrub'
import type { ParsedUserAgent } from '../../shared/user-agent'
import { parseUserAgent } from '../../shared/user-agent'
import { monitorConfig, useMonitorStore } from '../context'
import { clientAddress, isSameOrigin } from '../proxy'

/**
 * Client error intake.
 *
 * This is the one route without a session — the browser posts here, and it has
 * no credentials to offer. It is therefore treated as hostile input: bounded
 * body, bounded batch, per-address rate limit, and same-origin only.
 */

const MAX_BATCH = 20
const MAX_MESSAGE = 1_000
const MAX_STACK = 10_000
const MAX_BREADCRUMBS = 30
const MAX_SESSION = 64
const MAX_RELEASE = 64

/** Events accepted per address per window, before anything is written. */
const RATE_LIMIT = 100
const RATE_WINDOW_MS = 60_000

/** Ceiling on tracked addresses. See `prune`. */
const MAX_RATE_ENTRIES = 10_000

/**
 * Ceiling on the request body, before anything parses it.
 *
 * The per-field caps below only apply once `readBody` has already built the
 * whole object in memory, so they bound what is *stored* and not what it costs
 * to get there. A batch of twenty events with a 10 KB stack each fits inside
 * this comfortably; a megabyte of JSON from an endpoint that needs no
 * credentials does not.
 */
const MAX_BODY_BYTES = 512 * 1_024

/** Distinct from `undefined`, which only means the body was unreadable. */
const TOO_LARGE = Symbol('too-large')

const rate = new Map<string, { count: number, reset: number }>()

export default defineEventHandler(async (event) => {
  const config = monitorConfig()

  // A cross-origin post cannot be a genuine report from this app, and letting
  // one through would let any site fill the database.
  if (!isSameOrigin(event)) {
    setResponseStatus(event, 204)
    return null
  }

  if (isRateLimited(clientAddress(event))) {
    setResponseStatus(event, 429)
    return null
  }

  const raw = await readBoundedBody(event)

  if (raw === TOO_LARGE) {
    setResponseStatus(event, 413)
    return null
  }

  const body = parseJson(raw)
  const incoming = Array.isArray(body?.events) ? body.events.slice(0, MAX_BATCH) : []

  if (incoming.length === 0) {
    setResponseStatus(event, 204)
    return null
  }

  const store = await useMonitorStore()
  const options = { extraKeys: config.scrubKeys }

  // Parsed once per batch rather than per event: every event in one post came
  // from the same browser by definition.
  const agent = parseUserAgent(getRequestHeader(event, 'user-agent'))
  let accepted = 0

  for (const candidate of incoming) {
    // Isolated per event. `capture` hashes, scrubs and may flush synchronously,
    // and a single malformed event throwing used to take the remaining
    // nineteen of the batch with it — and answer 500 to a browser that was
    // only reporting an error in the first place.
    try {
      const normalized = normalize(candidate, options)

      if (normalized) {
        normalized.facets = facetsOf(candidate, agent, config.release)
        store.capture(normalized)
        accepted++
      }
    }
    catch {
      // Dropping one report is the smallest possible failure here.
    }
  }

  setResponseStatus(event, 202)
  return { accepted }
})

/**
 * Reads the body, refusing anything past the ceiling.
 *
 * The declared length is checked first because it is free, but it is also a
 * claim by the caller — the accumulated size is what actually decides, so a
 * lying or absent `content-length` changes nothing.
 */
async function readBoundedBody(event: H3Event): Promise<string | undefined | typeof TOO_LARGE> {
  const declared = Number(getRequestHeader(event, 'content-length'))

  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return TOO_LARGE
  }

  const raw = await readRawBody(event, false).catch(() => undefined)

  if (!raw) {
    return undefined
  }

  const buffer = typeof raw === 'string' ? Buffer.from(raw) : raw

  return buffer.byteLength > MAX_BODY_BYTES ? TOO_LARGE : buffer.toString('utf8')
}

function parseJson(raw: string | undefined): { events?: unknown[] } | null {
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as { events?: unknown[] }
  }
  catch {
    return null
  }
}

/**
 * Rejects anything the client sends that is not shaped like an event.
 *
 * Returns a value built field by field rather than spreading the input, so no
 * unexpected key reaches the database.
 */
function normalize(raw: unknown, options: { extraKeys: string[] }): MonitorEvent | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }

  const input = raw as Record<string, unknown>
  const message = typeof input.message === 'string' ? input.message : ''

  if (!message) {
    return undefined
  }

  const timestamp = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
    ? clampTimestamp(input.timestamp)
    : Date.now()

  return {
    side: 'client',
    type: typeof input.type === 'string' ? input.type.slice(0, 100) : 'Error',
    message: message.slice(0, MAX_MESSAGE),
    stack: typeof input.stack === 'string' ? input.stack.slice(0, MAX_STACK) : undefined,
    timestamp,
    context: input.context && typeof input.context === 'object'
      ? scrub(sanitizeContext(input.context as Record<string, unknown>, options), options)
      : undefined,
    breadcrumbs: normalizeBreadcrumbs(input.breadcrumbs, options),
    // Re-derived from the body rather than trusted: this route takes no
    // credentials, so `manual` is a claim anyone can make. It is accepted
    // because the worst a forged one can do is put a row in a list the owner
    // of the app is already looking at — but the level and the group are
    // normalised through the same functions the composable uses, so a value
    // that could not have come from `exception()` cannot arrive through here
    // either, and neither can reach a column unbounded.
    ...manualFields(input),
    // From the URL the browser reported. There is no `Accept` header to
    // consult — the page's own request is long over — but a client error
    // carries the page it happened on, and that is a page by construction
    // unless the path says otherwise.
    kind: routeKind(typeof (input.context as Record<string, unknown> | undefined)?.url === 'string'
      ? (input.context as Record<string, string>).url
      : undefined),
  }
}

/** The three fields a manual report carries, or nothing at all. */
function manualFields(input: Record<string, unknown>): Partial<MonitorEvent> {
  if (input.manual !== true) {
    return {}
  }

  return {
    manual: true,
    level: normalizeLevel(input.level),
    group: normalizeGroup(input.group),
  }
}

/**
 * Facets for a client event.
 *
 * Browser and OS come from the request's own `User-Agent` header, never from
 * the body: a field the client supplies is a field the client can lie about,
 * and a facet panel poisoned with invented browsers would be worse than no
 * panel. Only the two things the server cannot know — which tab this was and
 * which release the page was built from — are taken from the payload, and both
 * are bounded and stripped of anything that is not plainly an identifier.
 */
function facetsOf(raw: unknown, agent: ParsedUserAgent, release: string): MonitorFacets {
  const sent = (raw as { facets?: unknown }).facets
  const claimed = sent && typeof sent === 'object' ? sent as Record<string, unknown> : {}

  return {
    session: identifier(claimed.session, MAX_SESSION),
    browser: agent.browser,
    browserVersion: agent.browserVersion,
    os: agent.os,
    osVersion: agent.osVersion,
    deviceType: agent.deviceType,
    // The build-time value wins; a client may only supply one when the server
    // has none, so a forged release cannot mask the real one.
    release: release || identifier(claimed.release, MAX_RELEASE),
  }
}

/**
 * Accepts a value only if it looks like an identifier.
 *
 * These become facet rows and filter values, so anything else — punctuation,
 * whitespace, a whole JSON document — is dropped rather than truncated.
 */
function identifier(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined
  }

  const trimmed = value.slice(0, max)

  return /^[\w.@/-]+$/.test(trimmed) ? trimmed : undefined
}

function sanitizeContext(
  context: Record<string, unknown>,
  options: { extraKeys: string[] },
): Record<string, unknown> {
  const out = { ...context }

  // URLs routinely carry tokens in query parameters.
  for (const key of ['url', 'route', 'referrer']) {
    if (typeof out[key] === 'string') {
      out[key] = scrubUrl(out[key], options)
    }
  }

  return out
}

function normalizeBreadcrumbs(raw: unknown, options: { extraKeys: string[] }): MonitorBreadcrumb[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }

  const out: MonitorBreadcrumb[] = []

  for (const item of raw.slice(-MAX_BREADCRUMBS)) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const crumb = item as Record<string, unknown>
    const type = crumb.type

    if (type !== 'navigation' && type !== 'fetch' && type !== 'console' && type !== 'click') {
      continue
    }

    out.push({
      type,
      timestamp: typeof crumb.timestamp === 'number' ? clampTimestamp(crumb.timestamp) : Date.now(),
      message: typeof crumb.message === 'string' ? scrubUrl(crumb.message.slice(0, 500), options) : '',
      data: crumb.data && typeof crumb.data === 'object'
        ? scrub(crumb.data as Record<string, unknown>, options)
        : undefined,
    })
  }

  return out.length ? out : undefined
}

/**
 * Keeps client clocks from placing events far in the past or future, where
 * they would either escape retention or never expire.
 */
function clampTimestamp(value: number): number {
  const now = Date.now()
  const dayAgo = now - 24 * 60 * 60 * 1_000

  return Math.min(Math.max(value, dayAgo), now)
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rate.get(ip)

  if (!entry || now > entry.reset) {
    rate.set(ip, { count: 1, reset: now + RATE_WINDOW_MS })
    prune(now)

    return false
  }

  entry.count++

  return entry.count > RATE_LIMIT
}

/**
 * Bounds the rate-limit table.
 *
 * Expiring entries is the cheap pass, but it is not a bound: a burst of
 * distinct addresses — trivial to produce behind IPv6 or a spoofed
 * `x-forwarded-for` — leaves every entry live and the map above the ceiling
 * anyway. So when sweeping is not enough, the oldest are evicted outright.
 * Losing a limiter entry only means an address gets a fresh allowance; letting
 * the map grow means an attacker chooses how much memory this process uses.
 */
function prune(now: number): void {
  if (rate.size <= MAX_RATE_ENTRIES) {
    return
  }

  for (const [key, value] of rate) {
    if (now > value.reset) {
      rate.delete(key)
    }
  }

  // Map iterates in insertion order, so this drops the least recently added.
  for (const key of rate.keys()) {
    if (rate.size <= MAX_RATE_ENTRIES) {
      break
    }

    rate.delete(key)
  }
}
