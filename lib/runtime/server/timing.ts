import type { H3Event } from 'h3'

/**
 * How long a failing request had been running when it broke.
 *
 * A status says what went wrong; the duration says which kind of wrong. A 500
 * returned in 3ms is a guard clause rejecting the input — the handler never
 * got started. The same 500 after 30 seconds is a timeout on something
 * downstream, and the two are not investigated in the same place or by the
 * same person. Without it the reader guesses, and the usual guess is the fast
 * one, because that is what a stack trace looks like when you read it.
 *
 * Only failures are ever measured. A successful request is not timed, stored
 * or aggregated here: this is context on an error, not a performance product,
 * and per-route latency is a different feature with a different cost.
 */

/** Where the start is parked, on the event's own context. */
const STARTED = '_monitorStartedAt'

/**
 * Stamps the request with the moment it arrived.
 *
 * Uses the wall clock rather than `performance.now()` deliberately. The value
 * is only ever subtracted from another reading taken the same way, so the
 * monotonic clock's one advantage — immunity to the system clock being set —
 * buys a millisecond of accuracy on a number rendered as "183 ms", while
 * `Date.now()` is what every other timestamp in this module already uses.
 */
export function markRequestStart(event: H3Event): void {
  (event.context as Record<string, unknown>)[STARTED] = Date.now()
}

/**
 * Milliseconds since the request arrived, if anybody marked it.
 *
 * Undefined rather than zero when the start is missing — an error raised
 * outside a request, or one whose event never passed through the request hook.
 * Zero would render as "0 ms", which reads as an instantaneous failure rather
 * than an unmeasured one, and that is a claim this cannot make.
 */
export function requestDuration(event: H3Event | undefined, now = Date.now()): number | undefined {
  const started = (event?.context as Record<string, unknown> | undefined)?.[STARTED]

  if (typeof started !== 'number') {
    return undefined
  }

  const elapsed = now - started

  // A negative reading means the clock moved backwards between the two
  // readings — NTP correcting the machine mid-request. Reporting "-4 ms" would
  // be worse than reporting nothing.
  return elapsed >= 0 ? elapsed : undefined
}
