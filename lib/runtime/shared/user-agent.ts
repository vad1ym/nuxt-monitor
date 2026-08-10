import UAParserDefault from 'ua-parser-js'

/**
 * User-Agent parsing, for the browser/OS facets.
 *
 * The parsing itself is `ua-parser-js` rather than our own regexes: the UA
 * string is a thirty-year pile of compatibility lies, and a hand-rolled parser
 * is wrong in ways nobody notices until a facet quietly says `Safari` about
 * Chrome. Pinned to 1.x — 2.x is AGPL, which a MIT module cannot depend on.
 *
 * Runs on the server, at ingest, never in the browser: it is a build-time
 * dependency of the module and never reaches the user's bundle.
 */

/** 1.x is CommonJS, so the callable parser arrives as the default export. */
const UAParser = (UAParserDefault as unknown as { UAParser?: typeof UAParserDefault }).UAParser
  ?? UAParserDefault

export type MonitorDeviceType = 'desktop' | 'mobile' | 'tablet' | 'other'

export interface ParsedUserAgent {
  browser?: string
  /** Major version only: `120`, not `120.0.6099.109`. */
  browserVersion?: string
  os?: string
  osVersion?: string
  deviceType: MonitorDeviceType
}

/**
 * Parsing is not free and the same handful of UA strings repeats across every
 * event in a batch, so results are memoised. Bounded, because the key is
 * attacker-controlled.
 */
const cache = new Map<string, ParsedUserAgent>()
const CACHE_LIMIT = 500

const UNKNOWN: ParsedUserAgent = { deviceType: 'other' }

export function parseUserAgent(ua: string | undefined): ParsedUserAgent {
  if (!ua) {
    return UNKNOWN
  }

  const key = ua.slice(0, 400)
  const cached = cache.get(key)

  if (cached) {
    return cached
  }

  const parsed = parse(key)

  if (cache.size >= CACHE_LIMIT) {
    cache.clear()
  }

  cache.set(key, parsed)

  return parsed
}

function parse(ua: string): ParsedUserAgent {
  let result

  try {
    result = new UAParser(ua).getResult()
  }
  catch {
    // A malformed UA must not fail an ingest — the error report matters more
    // than the facet attached to it.
    return UNKNOWN
  }

  return {
    browser: result.browser.name || undefined,
    // The major alone is what a facet is useful over: `Chrome 120` groups,
    // `Chrome 120.0.6099.109` gives every patch release its own bucket.
    browserVersion: qualify(result.browser.name, result.browser.major),
    os: result.os.name || undefined,
    osVersion: qualify(result.os.name, result.os.version),
    deviceType: deviceType(result.device.type),
  }
}

/**
 * A version carries its name: `Safari 17`, not `17`.
 *
 * Stored qualified rather than joined for display, because the value is read
 * in three places — the environments column, the filter dropdown and the
 * breakdown inside an issue — and only one of them has the parent nearby. A
 * bare `17` next to a bare `10` names nothing, and worse, two browsers at
 * major 17 would group into one row that means neither of them.
 */
function qualify(name: string | undefined, version: string | undefined): string | undefined {
  if (!version) {
    return undefined
  }

  return name ? `${name} ${version}` : version
}

/**
 * `ua-parser-js` reports no type at all for desktops — there is nothing in a
 * desktop UA that says "desktop", it is what remains once nothing else matches.
 * A facet needs the value spelled out, so absence becomes `desktop` and the
 * long tail (console, smarttv, wearable, embedded) collapses into `other`.
 */
function deviceType(type: string | undefined): MonitorDeviceType {
  if (!type) {
    return 'desktop'
  }

  return type === 'mobile' || type === 'tablet' ? type : 'other'
}
