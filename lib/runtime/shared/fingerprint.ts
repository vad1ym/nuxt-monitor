import { createHash } from 'node:crypto'
import type { MonitorEvent } from '../../types'
import { isVendorFrame } from './vendor-frame'

/**
 * Groups occurrences of the same fault into one issue.
 *
 * The inputs are the error type, a normalized message, and the topmost stack
 * frame that belongs to the application. Everything volatile is stripped
 * first: ids, hashes, quoted values and numbers vary per occurrence and would
 * otherwise split one fault across hundreds of issues.
 */
export function fingerprint(
  event: Pick<MonitorEvent, 'type' | 'message' | 'stack' | 'side'> & Pick<Partial<MonitorEvent>, 'group'>,
): string {
  const parts = [
    event.side,
    event.type,
    normalizeMessage(event.message),
    topFrame(event.stack),
  ]

  // Appended only when there is one, so every fingerprint written before groups
  // existed hashes to exactly what it did before. An extra empty part would
  // change every hash in the table, and an upgrade would silently split each
  // open issue into a new one beside the old — the errors people are working on
  // would appear to be freshly discovered.
  //
  // Two `exception()` calls saying the same thing about payments and about data
  // integrity are two things worth watching apart; that is what naming a group
  // is for.
  if (event.group) {
    parts.push(event.group)
  }

  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/**
 * A quoted token that names something in the code rather than carrying data.
 *
 * `Cannot read properties of undefined (reading 'width')` and the same
 * sentence ending `'remaining'` are two different bugs, and replacing both
 * quoted words with `<str>` merged them into one issue — in development, where
 * every handler compiles into a single bundle and the top frame is identical
 * too, that is two unrelated faults sharing a row.
 *
 * An identifier is the one kind of quoted value that is part of the fault
 * rather than part of the request: it comes from the source, so it is the same
 * on every occurrence, which is exactly the property the volatile rules exist
 * to strip. Deliberately strict — a bare identifier, at most 40 characters, no
 * spaces, no dots, no `@`. An email, a path or a sentence still becomes
 * `<str>`.
 */
const IDENTIFIER = /^[a-z_$][\w$]{0,39}$/i

/**
 * A quoted token that is a request path rather than a value or a sentence.
 *
 * `$fetch` spells its failures `[GET] "/api/health-pages/bol-v-molochnye-zhelezy": 404`,
 * and the path is the only part naming what broke. Collapsed whole to `<str>`
 * it left `[GET] <str>: <n>` — a key every 404 in the application hashes to,
 * so a missing health page, a missing root page and a mistyped endpoint became
 * one issue with one of their messages as its title and another's request in
 * the badge beside it. Two unrelated faults reading as cause and effect.
 *
 * So a path keeps its shape and loses only its variable segments, the same
 * distinction `replaceQuoted` already draws for identifiers: structure comes
 * from the source and is the same on every occurrence, values come from the
 * request and are not.
 *
 * Deliberately strict about what counts as a path — a leading slash, no
 * spaces, no `@`. A sentence that merely mentions a slash still becomes
 * `<str>`.
 */
const QUOTED_PATH = /^\/[^\s'"@]*$/

/** Long, hyphen-heavy tail segments are content slugs, not route structure. */
const SLUG_MIN_LENGTH = 20
const SLUG_MIN_HYPHENS = 3

/**
 * Reduces a quoted path to the endpoint it names.
 *
 * The variable segments go, because they vary per request and would file one
 * issue per slug — a thousand missing health pages are one fault ("the content
 * is not there"), not a thousand, and an issue list that grows with the
 * catalogue rather than with the number of bugs is the same failure
 * `normalizeRoute` exists to prevent in the counters.
 *
 * Numbers, uuids and hashes are left to the volatile patterns that run after
 * this; what they cannot recognise is a slug of ordinary words, which is only
 * distinguishable from a static segment by position and shape. Hence the
 * heuristic, and hence it applying to the last segment alone: `health-pages`
 * is structure and `bol-v-molochnye-zhelezy` is data, and nothing but their
 * place in the path says so.
 */
function normalizePath(path: string): string {
  const [withoutQuery = ''] = path.split('?')
  const segments = withoutQuery.split('/')
  const last = segments.length - 1
  const tail = segments[last] ?? ''

  // A file keeps its name: `entry.js` is structure, and the hash inside it is
  // handled by the volatile patterns.
  if (last < 1 || /\.[a-z0-9]{1,8}$/i.test(tail)) {
    return withoutQuery
  }

  const hyphens = tail.split('-').length - 1

  if (tail.length > SLUG_MIN_LENGTH || hyphens >= SLUG_MIN_HYPHENS) {
    segments[last] = '<slug>'
  }

  return segments.join('/')
}

const VOLATILE_PATTERNS: [RegExp, string][] = [
  // UUIDs, then long hex runs (ids, content hashes, object addresses).
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{16,}\b/gi, '<hash>'],
  // Bare numbers last, so it does not eat digits inside the tokens above.
  [/\b\d+\b/g, '<n>'],
]

/**
 * Quoted payloads: `"user@example.com not found"` and `"user@other.com not
 * found"` are the same fault — unless what is quoted is an identifier, which
 * names the fault instead of describing one request.
 */
function replaceQuoted(message: string): string {
  return message.replace(/'([^']*)'|"([^"]*)"/g, (whole, single, double) => {
    const inner = single ?? double ?? ''

    if (IDENTIFIER.test(inner)) {
      return whole
    }

    // A path is neither an identifier nor an opaque value: it has structure
    // worth keeping and detail worth losing, so it is normalised rather than
    // kept or replaced.
    if (!QUOTED_PATH.test(inner)) {
      return '<str>'
    }

    // Re-quoted the way it arrived: the quote character is part of the
    // surrounding message, and rewriting `'/a'` as `"/a"` would fingerprint two
    // spellings of one message apart.
    const quote = single === undefined ? '"' : `'`

    return `${quote}${normalizePath(inner)}${quote}`
  })
}

/** Strips the parts of a message that differ between occurrences. */
export function normalizeMessage(message: string): string {
  // Quoted values first, and by function rather than by pattern: whether a
  // quoted token is stripped depends on what is inside it.
  let out = replaceQuoted(message.trim())

  for (const [pattern, replacement] of VOLATILE_PATTERNS) {
    out = out.replace(pattern, replacement)
  }

  // Collapse whitespace so wrapping differences do not matter.
  return out.replace(/\s+/g, ' ').slice(0, 500)
}

/**
 * The first stack line pointing at application code.
 *
 * Frames inside node_modules and the framework runtime are skipped: the same
 * bug surfaces through different library frames depending on the call path,
 * and grouping on those would scatter it.
 */
export function topFrame(stack: string | undefined): string {
  if (!stack) {
    return ''
  }

  const lines = stack.split('\n').slice(1)

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed.startsWith('at ')) {
      continue
    }

    if (isVendorFrame(trimmed)) {
      continue
    }

    return normalizeFrame(trimmed)
  }

  // Everything was vendor code — fall back to the first frame so distinct
  // library faults still separate.
  const first = lines.find(line => line.trim().startsWith('at '))
  return first ? normalizeFrame(first.trim()) : ''
}

/**
 * Reduces a frame to the part that identifies the fault.
 *
 * Line and column go, so an edit above the failure does not fork the issue.
 * The build directory goes too: server frames carry the absolute path of the
 * Nitro output, which changes on every deploy — keeping it would file a fresh
 * issue for the same bug after each release, and the history that makes a
 * report worth reading would reset with it. Build hashes go for the same
 * reason: `page-C2V2OSOE.mjs` and `page-6A6825Cy.mjs` are the same module.
 */
function normalizeFrame(frame: string): string {
  return frame
    .replace(/:\d+:\d+/g, '')
    .replace(/\?[^\s)]*/g, '')
    // Anchor server frames at the build output rather than at the filesystem.
    .replace(/\bfile:\/\/\S*?\/(?:\.output|\.nuxt)\//g, '')
    .replace(/^\s*at\s+\S*?\/(?:\.output|\.nuxt)\//, 'at ')
    // `name-<hash>.mjs` — the module name is kept, the build hash is not.
    .replace(/-[\w-]{8,}(?=\.[a-z]+\b)/g, '-<hash>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')
    .trim()
}
