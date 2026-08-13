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

    return IDENTIFIER.test(inner) ? whole : '<str>'
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
