import type { H3Event } from 'h3'
import { describe, expect, it } from 'vitest'
import { bound, captureBodies, snapshotRequestBody } from './bodies'

/**
 * Bodies.
 *
 * Two things are worth testing here and they pull in opposite directions: the
 * payload has to be there, because it is what makes a stack actionable — and
 * it must not be there by accident, because it is where passwords live.
 */

const SCRUB = { extraKeys: [] }

/**
 * An event carrying whatever h3 parsed for the request.
 *
 * Under the symbol h3 actually uses. Guessing the key was the first version of
 * this and it passed every test while capturing nothing in a running app:
 * `readBody` caches under `Symbol.for('h3ParsedBody')`, and a test that
 * invents its own key proves only that the reader can read it back.
 */
function eventWith(body: unknown): H3Event {
  return { node: { req: { [Symbol.for('h3ParsedBody')]: body } } } as unknown as H3Event
}

describe('what is captured', () => {
  it('keeps the response body without being asked', () => {
    // Written by the application rather than supplied by a visitor, and for a
    // failure it is usually the error envelope somebody would ask for first.
    const captured = captureBodies(
      eventWith({ any: 'thing' }),
      { data: { reason: 'insufficient stock' } },
      undefined,
      SCRUB,
    )

    expect(captured.responseBody).toEqual({ reason: 'insufficient stock' })
  })

  it('does not keep the request body unless it is turned on', () => {
    // The default is the one that cannot leak a password.
    const captured = captureBodies(
      eventWith({ password: 'hunter2' }),
      {},
      undefined,
      SCRUB,
    )

    expect(captured.requestBody).toBeUndefined()
  })

  it('keeps the request body when it is', () => {
    const captured = captureBodies(
      eventWith({ lines: [{ slug: 'rug' }] }),
      {},
      { request: true },
      SCRUB,
    )

    expect(captured.requestBody).toEqual({ lines: [{ slug: 'rug' }] })
  })

  it('redacts what it keeps', () => {
    // A safety net rather than a licence: it matches keys, which is exactly
    // why the request half is off by default.
    const captured = captureBodies(
      eventWith({ cardToken: '4242424242424242', slug: 'rug' }),
      {},
      { request: true },
      SCRUB,
    )

    expect(JSON.stringify(captured.requestBody)).not.toContain('4242')
    expect(JSON.stringify(captured.requestBody)).toContain('rug')
  })

  it('can be turned off entirely', () => {
    const captured = captureBodies(
      eventWith({ a: 1 }),
      { data: { b: 2 } },
      { request: false, response: false },
      SCRUB,
    )

    expect(captured).toEqual({})
  })

  it('prefers the snapshot taken while the request was still running', () => {
    // The reason the snapshot exists: an error travels up through Nitro before
    // it is dispatched, and the event that arrives at the hook is not reliably
    // carrying the `node.req` the handler parsed from. Reading the cache alone
    // captured a body on some occurrences and not others, which is worse than
    // never capturing one — it invites a conclusion about the requests that
    // "had no body".
    const event = { node: { req: {} }, context: {} } as unknown as H3Event

    snapshotRequestBody(
      { node: { req: { [Symbol.for('h3ParsedBody')]: { taken: 'early' } } }, context: event.context } as unknown as H3Event,
      { request: true },
    )

    expect(captureBodies(event, {}, { request: true }, SCRUB).requestBody)
      .toEqual({ taken: 'early' })
  })

  it('takes no snapshot when the option is off', () => {
    const event = { node: { req: { [Symbol.for('h3ParsedBody')]: { a: 1 } } }, context: {} } as unknown as H3Event

    snapshotRequestBody(event, undefined)

    expect((event.context as Record<string, unknown>)._monitorRequestBody).toBeUndefined()
  })

  it('reads nothing when the handler never parsed a body', () => {
    // A request whose body was never read did not fail because of it, and
    // reading the stream here would be reading one that is already consumed.
    const captured = captureBodies(
      { node: { req: {} } } as unknown as H3Event,
      {},
      { request: true },
      SCRUB,
    )

    expect(captured.requestBody).toBeUndefined()
  })
})

describe('bounds', () => {
  it('truncates a long string and says so', () => {
    const out = bound('x'.repeat(100), 10)

    expect(out).toMatch(/^x{10}…\[truncated\]$/)
  })

  it('turns an oversized object into a marked string', () => {
    // Half a JSON document is not a JSON document, and storing one as an
    // object would put unparseable values in the database.
    const out = bound({ items: Array.from({ length: 200 }, (_, i) => i) }, 50)

    expect(typeof out).toBe('string')
    expect(out).toContain('[truncated]')
  })

  it('keeps a small object as an object', () => {
    expect(bound({ a: 1 }, 1_000)).toEqual({ a: 1 })
  })

  it('survives a value that cannot be serialized', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    // A failed report stays a failed report; it does not become a second error
    // for somebody else to investigate.
    expect(bound(circular, 100)).toBeUndefined()
  })
})
