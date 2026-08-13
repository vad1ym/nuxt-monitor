import type { MonitorEvent, MonitorIgnoreOptions } from '../../types'

/**
 * Decides what never reaches the database.
 *
 * Filtering on the way in rather than on the way out: noise that is stored
 * still costs disk, still has to be paged past, and still dilutes the counts
 * that tell you which fault is spreading. A 404 is the usual case — it says a
 * client asked for something absent, which is not a fault in the application.
 */

/** 4xx by default: client mistakes, not application faults. */
const DEFAULT_STATUSES = [400, 401, 402, 403, 404, 405, 406, 408, 409, 410, 422, 429]

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
