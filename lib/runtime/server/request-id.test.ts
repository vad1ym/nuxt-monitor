import type { H3Event } from 'h3'
import { describe, expect, it } from 'vitest'
import { markRequestId, requestId } from './request-id'

/**
 * The correlation id.
 *
 * What matters is not that an id exists — it is that it matches whatever is
 * already identifying this request outside the process. An id we invented
 * while nginx logged a different one is two ids for one request, which reads
 * like it should work and does not.
 */

function fakeEvent(): H3Event {
  return { context: {} } as unknown as H3Event
}

describe('request id', () => {
  it('adopts an inbound x-request-id', () => {
    const event = fakeEvent()

    markRequestId(event, { 'x-request-id': 'abc-123' })

    expect(requestId(event)).toBe('abc-123')
  })

  it('prefers x-request-id over the other correlation headers', () => {
    const event = fakeEvent()

    markRequestId(event, { 'x-request-id': 'chosen', 'cf-ray': 'ignored' })

    expect(requestId(event)).toBe('chosen')
  })

  it('falls back through the other known headers', () => {
    const event = fakeEvent()

    markRequestId(event, { 'cf-ray': 'ray-9' })

    expect(requestId(event)).toBe('ray-9')
  })

  it('generates one when no proxy set any', () => {
    const event = fakeEvent()

    markRequestId(event, {})

    expect(requestId(event)).toMatch(/^[a-z0-9]{16}$/)
  })

  it('ignores a blank header rather than adopting an empty id', () => {
    // A proxy that sets the header but leaves it empty would otherwise give
    // every request the same id: none of them.
    const event = fakeEvent()

    markRequestId(event, { 'x-request-id': '   ' })

    expect(requestId(event)).toMatch(/^[a-z0-9]{16}$/)
  })

  it('bounds an inbound id, which comes off the wire', () => {
    const event = fakeEvent()

    markRequestId(event, { 'x-request-id': 'x'.repeat(500) })

    expect(requestId(event)).toHaveLength(200)
  })

  it('decides once, so one request cannot get two identities', () => {
    const event = fakeEvent()

    const first = markRequestId(event, {})
    const second = markRequestId(event, { 'x-request-id': 'late' })

    expect(second).toBe(first)
    expect(requestId(event)).toBe(first)
  })

  it('is undefined for an error with no request behind it', () => {
    // An unhandledRejection in a timer belongs to no request; an id for it
    // would promise a correlation that leads nowhere.
    expect(requestId(undefined)).toBeUndefined()
    expect(requestId(fakeEvent())).toBeUndefined()
  })

  it('gives two requests different ids', () => {
    const a = fakeEvent()
    const b = fakeEvent()

    expect(markRequestId(a, {})).not.toBe(markRequestId(b, {}))
  })
})
