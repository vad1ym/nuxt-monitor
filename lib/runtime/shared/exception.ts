import type { MonitorLevel } from '../../types'

/**
 * Turning a hand-written report into an event.
 *
 * Shared by both sides so a call reads the same in a server route and in a
 * component, and so the two cannot drift into producing different shapes for
 * the same call — which would split one thing worth watching into two issues
 * depending on where it was reported from.
 */

/**
 * The type recorded for every manual report.
 *
 * A fixed type rather than the message, because the type is what a fingerprint
 * and the issue list group and label by. It also keeps manual reports out of
 * the error-type facet's tail, where a hundred distinct one-off types would
 * bury `TypeError`.
 */
export const EXCEPTION_TYPE = 'MonitorException'

const LEVELS: MonitorLevel[] = ['info', 'warning', 'error', 'critical']

/** Anything that is not one of the four is `error`, the sensible default. */
export function normalizeLevel(value: unknown): MonitorLevel {
  return LEVELS.includes(value as MonitorLevel) ? value as MonitorLevel : 'error'
}

/**
 * Bounds a group name to what can be a column value and a filter.
 *
 * Restricted to identifier characters for the same reason facet values are:
 * these end up in a filter dropdown and in notification routing, and a group
 * carrying whitespace or punctuation is one that cannot be matched reliably
 * against a rule somebody typed into a config file.
 */
export function normalizeGroup(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim().slice(0, 64)

  return trimmed && /^[\w.:@/-]+$/.test(trimmed) ? trimmed : undefined
}

/**
 * The stack of the call site, without this function in it.
 *
 * A manual report has no thrown error to take a stack from, so one is made
 * here. The two frames dropped are this function and the `exception()` that
 * called it — leaving them would make every manual report appear to originate
 * inside nuxt-monitor, and since the top application frame is part of the
 * fingerprint, *every* manual report in the app would group into one issue.
 */
export function callSiteStack(skip = 2): string | undefined {
  const stack = new Error(EXCEPTION_TYPE).stack

  if (!stack) {
    return undefined
  }

  const [head, ...frames] = stack.split('\n')

  return [head, ...frames.slice(skip)].join('\n')
}
