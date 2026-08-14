import type { MonitorEvent, MonitorIgnoreOptions } from '../../types'

/**
 * Decides what never reaches the database.
 *
 * Filtering on the way in rather than on the way out: noise that is stored
 * still costs disk, still has to be paged past, and still dilutes the counts
 * that tell you which fault is spreading.
 *
 * The bias is deliberately towards recording. A missed error costs an
 * afternoon; an extra row costs one click on Ignore — and the tool cannot know
 * which is which, because a status code is a claim the application makes about
 * itself and applications make it inconsistently. Plenty of APIs answer 400 or
 * 422 for "your own frontend sent nonsense", which is exactly a bug, and some
 * answer 200 with `{ error: true }`. Silence by default is the wrong default
 * for a monitoring tool.
 */

/**
 * The two statuses that are never the application's fault.
 *
 * `404` says a client asked for something absent — a stale link, a bot, a
 * scanner — and on a public site it is most of the 4xx traffic there is.
 * `429` is the rate limiter working: it fired because it was configured to,
 * and recording it as a fault would make the defence look like the failure.
 *
 * Everything else is recorded, **including the rest of the 4xx range**. It
 * used to hold all of them, and that hid real bugs: a 422 raised by a page's
 * own `$fetch` — `manufacturer_slug=null` reaching an API that rejects it —
 * takes the page down with "Something went wrong" and never appears here. That
 * is not a client mistake, it is a null that should never have been sent.
 */
const DEFAULT_STATUSES = [404, 429]

export interface CompiledIgnore {
  statuses: Set<number>
  messages: Matcher[]
  routes: Matcher[]
  types: Set<string>
}

export type Matcher = (value: string) => boolean

/** Prepares the rules once, so matching stays cheap on the request path. */
export function compileIgnore(options: MonitorIgnoreOptions | undefined): CompiledIgnore {
  return {
    statuses: new Set(options?.statuses ?? DEFAULT_STATUSES),
    messages: (options?.messages ?? []).map(toMatcher),
    routes: (options?.routes ?? []).map(toMatcher),
    types: new Set(options?.types ?? []),
  }
}

export function shouldIgnore(event: MonitorEvent, rules: CompiledIgnore): boolean {
  const context = event.context ?? {}
  const status = typeof context.statusCode === 'number' ? context.statusCode : undefined

  if (status !== undefined && rules.statuses.has(status)) {
    return true
  }

  if (rules.types.has(event.type)) {
    return true
  }

  if (rules.messages.some(match => match(event.message))) {
    return true
  }

  const url = typeof context.url === 'string' ? context.url : undefined

  return url !== undefined && rules.routes.some(match => match(url))
}

/**
 * Builds a matcher from a config string.
 *
 * Exported because group rules (#17) match message text by exactly the same
 * rule, and a second implementation of "substring or `/regex/`" would be a
 * second set of edge cases for the same sentence in the documentation.
 *
 * `/pattern/flags` is treated as a regular expression; anything else is a
 * case-insensitive substring, which is what most people mean when they write a
 * rule by hand.
 */
export function toMatcher(pattern: string): Matcher {
  const asRegex = /^\/(.+)\/([gimsuy]*)$/.exec(pattern)
  let literal = pattern

  if (asRegex) {
    try {
      // `g` is dropped deliberately: a stateful `lastIndex` would make results
      // depend on how many times the matcher had run before.
      const regex = new RegExp(asRegex[1]!, (asRegex[2] ?? '').replace(/g/g, ''))

      return value => regex.test(value)
    }
    catch {
      // A malformed pattern still filters something rather than silently
      // matching nothing — but on its body, without the delimiters that only
      // ever meant "this is a regex".
      literal = asRegex[1]!
    }
  }

  const needle = literal.toLowerCase()

  return value => value.toLowerCase().includes(needle)
}
