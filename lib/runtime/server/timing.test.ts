import type { H3Event } from 'h3'
import { describe, expect, it } from 'vitest'
import { markRequestStart, requestDuration } from './timing'

/**
 * How long the request had been running.
 *
 * The value itself is a subtraction and not worth a test. What is worth one is
 * every case where the answer must be *absent*: an unmeasured request has to
 * read as unmeasured, because "0 ms" is a claim about how the failure happened.
 */

function fakeEvent(): H3Event {
  return { context: {} } as unknown as H3Event
}

describe('request duration', () => {
  it('measures from the mark to the reading', () => {
    const event = fakeEvent()
    const started = 1_000

    markRequestStart(event);
    // Overwrite what the mark just wrote, so the test does not depend on how
    // long it takes to get to the next line.
    (event.context as Record<string, unknown>)._monitorStartedAt = started

    expect(requestDuration(event, started + 183)).toBe(183)
  })

  it('is undefined when nothing started the clock', () => {
    // A process-level rejection has no request behind it. Zero would describe
    // a request that failed instantly, which is a different thing entirely.
    expect(requestDuration(fakeEvent())).toBeUndefined()
  })

  it('is undefined without an event at all', () => {
    expect(requestDuration(undefined)).toBeUndefined()
  })

  it('is undefined when the clock moved backwards', () => {
    // NTP correcting the machine mid-request. "-4 ms" is worse than silence.
    const event = fakeEvent()

    markRequestStart(event);
    (event.context as Record<string, unknown>)._monitorStartedAt = 5_000

    expect(requestDuration(event, 4_996)).toBeUndefined()
  })

  it('counts a request that failed in the same millisecond as zero, not absent', () => {
    // The one case where zero is honest: the clock was started, and no time
    // passed. Distinct from never having been measured.
    const event = fakeEvent()

    markRequestStart(event);
    (event.context as Record<string, unknown>)._monitorStartedAt = 7_000

    expect(requestDuration(event, 7_000)).toBe(0)
  })
})
