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
    if (typeof value !== 'string') {
      return value
    }

    // Pattern-scrubbed as well as key-scrubbed. A token under an innocent key
    // — `detail`, `body`, `error` — is invisible to the key rules, and those
    // are exactly the keys an error payload uses.
    const cleaned = scrubSecrets(value)

    return cleaned.length > MAX_STRING
      ? `${cleaned.slice(0, MAX_STRING)}…[truncated]`
      : cleaned
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

/**
 * Credentials that give themselves away by their shape.
 *
 * Key-based redaction cannot help here, because there is no key: the secret is
 * inside a sentence. `Invalid token: sk-live-4eC39H…` is an error message an
 * application writes, and it is stored verbatim as the *identity* of an issue —
 * so a leak here is not one row, it is a row that is also a title, a search
 * result, and the text of every alert about it.
 *
 * Deliberately narrow. Each pattern matches a format that is a credential and
 * is not plausibly anything else, because the cost of a false positive is a
 * redacted error message nobody can debug. Anything looking merely "long and
 * random" is left alone — that describes hashes, ids and stack offsets too.
 */
const SECRET_PATTERNS: { name: string, pattern: RegExp }[] = [
  // Stripe and the many keys that copied its prefix convention.
  { name: 'key', pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  // GitHub: ghp_, gho_, ghu_, ghs_, ghr_, and github_pat_.
  { name: 'token', pattern: /\bgh[posur]_[A-Za-z0-9]{20,}/g },
  { name: 'token', pattern: /\bgithub_pat_\w{20,}/g },
  // Slack.
  { name: 'token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // AWS access key ids.
  { name: 'key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // OpenAI and friends.
  { name: 'key', pattern: /\bsk-[\w-]{20,}/g },
  // A JWT: three base64url segments, and the first decodes to a JSON header.
  // The shape is distinctive enough that nothing else matches it by accident.
  { name: 'jwt', pattern: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g },
  // `Bearer <something long>` — the header form, when it turns up in text.
  { name: 'token', pattern: /\bBearer\s+[\w.-]{20,}/gi },
]

/**
 * Replaces anything that looks like a credential with a marker naming its kind.
 *
 * `[redacted key]` rather than `[redacted]`, because the reader has to be able
 * to tell that the message was altered and roughly what was removed — a
 * silently shortened error message is a debugging trap.
 */
export function scrubSecrets(value: string): string {
  let out = value

  for (const { name, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, `[redacted ${name}]`)
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
