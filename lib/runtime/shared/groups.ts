import type { MonitorGroupOptions, MonitorGroupRule } from '../../types'
import type { Matcher } from './ignore'
import { toMatcher } from './ignore'

/**
 * Naming the parts of an application, from the config.
 *
 * A group is the one concept this module has for "what kind of thing is this,
 * and does anybody want to be told about it". `exception()` names one at the
 * call site; these rules name one for errors nobody annotated — a failure in
 * `/api/checkout` belongs to payments whether or not somebody remembered to
 * say so.
 *
 * Two ways to match, because they answer different questions:
 *
 * - **routes** — whose part of the application this is.
 * - **messages** — whose fault it is. A third-party provider rarely breaks on
 *   its own route; it breaks inside yours, and no path pattern will find it.
 *
 * Rules live in the config and nowhere else. They describe the architecture of
 * the application rather than an observation about it, so they belong beside
 * the code, in review, and identical across environments — unlike `resolved`
 * and `ignored`, which are what somebody concluded this afternoon.
 */

export interface CompiledGroup {
  name: string
  routes: Matcher[]
  messages: Matcher[]
  /** Whether an error in this group is worth an alert. */
  notify: boolean
}

/**
 * Prepares the rules once, at startup.
 *
 * Order is preserved, and the first match wins — see `groupFor`. Declaration
 * order is something the reader can see; "most specific" would ask them to
 * hold a specificity algorithm in their head to predict the outcome.
 */
export function compileGroups(options: MonitorGroupOptions | undefined): CompiledGroup[] {
  const compiled: CompiledGroup[] = []

  for (const [name, rule] of Object.entries(options ?? {})) {
    const normalized: MonitorGroupRule = Array.isArray(rule) ? { routes: rule } : rule

    compiled.push({
      name,
      routes: (normalized.routes ?? []).map(toRouteMatcher),
      messages: (normalized.messages ?? []).map(toMatcher),
      notify: normalized.notify === true,
    })
  }

  return compiled
}

/**
 * The group a captured error belongs to, if any.
 *
 * Checked against the raw path rather than the normalised route shape: a rule
 * is written while looking at the files in `server/api`, not at
 * `/api/orders/:id`, and making the author translate between the two is asking
 * them to know something the module could have known for them.
 */
export function groupFor(
  groups: CompiledGroup[],
  input: { route?: string, message?: string },
): CompiledGroup | undefined {
  for (const group of groups) {
    if (input.route !== undefined && group.routes.some(match => match(input.route!))) {
      return group
    }

    if (input.message !== undefined && group.messages.some(match => match(input.message!))) {
      return group
    }
  }

  return undefined
}

/** Looks up a group by name, for the dashboard and for notification routing. */
export function findGroup(groups: CompiledGroup[], name: string): CompiledGroup | undefined {
  return groups.find(group => group.name === name)
}

/**
 * A path pattern.
 *
 * Globs rather than the substring matching `ignore` uses, because a rule here
 * assigns an identity rather than dropping something: `/api` as a substring
 * would also claim `/internal/api-docs`, and an issue quietly filed under the
 * wrong team is worse than one filed under none.
 *
 * `**` spans separators, `*` does not, `:param` matches one segment — the
 * spellings a Nuxt developer already uses for routes.
 *
 * Globs only, with no `/regex/` escape hatch. Every path *is* a `/…/` string,
 * so the two spellings cannot be told apart without a rule nobody would guess
 * — and `messages` already covers the cases a glob cannot express.
 */
/** Stands in for `**` between the two star rules. Not a character a path holds. */
const DOUBLE_STAR = '\u0001double-star\u0001'

function toRouteMatcher(pattern: string): Matcher {
  const source = pattern
    .split('?')[0]!
    // Escape everything regex-significant, then reinstate the three wildcards.
    .replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    // `**` is parked under a placeholder first, or the single-star rule
    // below would consume half of it and leave two segment wildcards where
    // the author asked for one that crosses separators.
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    .replaceAll(DOUBLE_STAR, '.*')
    // `:param` is one segment, the same as a single star.
    .replace(/:[a-z_]\w*/gi, '[^/]+')

  // A trailing `/**` covers the section's own root as well as everything under
  // it. Nobody writing `/api/checkout/**` means "all of checkout except
  // `/api/checkout`", and being wrong here files the most obvious route in the
  // group under no group at all — silently, while the rule still looks right.
  const anchored = source.endsWith('/.*') ? `${source.slice(0, -3)}(?:/.*)?` : source

  // Anchored at both ends: a rule names a set of routes, and an unanchored
  // pattern would claim every path that merely contains one.
  const regex = new RegExp(`^${anchored}$`, 'i')

  return value => regex.test(value.split('?')[0]!)
}
