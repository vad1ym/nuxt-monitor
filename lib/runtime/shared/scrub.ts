/**
 * Redaction of sensitive values.
 *
 * This runs on the way *in*, before anything is written, so secrets never
 * reach the database in the first place. Scrubbing on read would leave them
 * on disk and one forgotten query away from exposure.
 */

const DEFAULT_SCRUB_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'api-key',
  'apikey',
  'auth',
  'session',
  'credentials',
  'x-csrf-token',
]

export const REDACTED = '[redacted]'

/** Guards against pathological nesting and cycles in captured payloads. */
const MAX_DEPTH = 8
const MAX_ARRAY = 100
const MAX_STRING = 8_000

export interface ScrubOptions {
  /** Extra key substrings to redact, on top of the built-in set. */
  extraKeys?: string[]
}

/**
 * Deep-copies a value, replacing anything whose key looks sensitive.
 *
 * Matching is substring-based and case-insensitive, so `X-Auth-Token`,
 * `userPassword` and `refresh_token` are all caught without enumerating every
 * spelling a framework might use.
 */
export function scrub<T>(value: T, options: ScrubOptions = {}): T {
  const keys = [...DEFAULT_SCRUB_KEYS, ...(options.extraKeys ?? [])].map(k => k.toLowerCase())
  const seen = new WeakSet<object>()

  return walk(value, keys, seen, 0) as T
}

function walk(value: unknown, keys: string[], seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[truncated]`
      : value
  }

  if (depth >= MAX_DEPTH) {
    return '[depth limit]'
  }

  // A cycle would otherwise recurse forever; captured payloads are arbitrary
  // user objects and do contain them.
  if (seen.has(value)) {
    return '[circular]'
  }
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map(item => walk(item, keys, seen, depth + 1))

    if (value.length > MAX_ARRAY) {
      items.push(`…and ${value.length - MAX_ARRAY} more`)
    }

    return items
  }

  const out: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitive(key, keys) ? REDACTED : walk(item, keys, seen, depth + 1)
  }

  return out
}

function isSensitive(key: string, keys: string[]): boolean {
  const lower = key.toLowerCase()
  return keys.some(candidate => lower.includes(candidate))
}

/**
 * Strips credentials and sensitive query parameters from a URL.
 *
 * Tokens travel in query strings more often than anyone intends, and a URL is
 * recorded for nearly every captured event.
 */
export function scrubUrl(url: string, options: ScrubOptions = {}): string {
  const keys = [...DEFAULT_SCRUB_KEYS, ...(options.extraKeys ?? [])].map(k => k.toLowerCase())

  try {
    // `base` keeps relative paths (the common case for a captured route) parseable.
    const parsed = new URL(url, 'http://monitor.invalid')

    if (parsed.username || parsed.password) {
      parsed.username = ''
      parsed.password = ''
    }

    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitive(key, keys)) {
        parsed.searchParams.set(key, REDACTED)
      }
    }

    return parsed.origin === 'http://monitor.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString()
  }
  catch {
    // Not a URL we can parse — better to drop it than to store something
    // unexamined that may carry a token.
    return '[unparseable url]'
  }
}
