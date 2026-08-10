import { describe, expect, it, vi } from 'vitest'
import type { ClientEvent } from './queue'
import { EventQueue, dedupeKey } from './queue'

function makeEvent(overrides: Partial<ClientEvent> = {}): ClientEvent {
  return {
    type: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at handler (/app/x.ts:3:9)',
    timestamp: 1_000,
    ...overrides,
  }
}

describe('dedupeKey', () => {
  it('matches the same fault from the same place', () => {
    expect(dedupeKey(makeEvent())).toBe(dedupeKey(makeEvent()))
  })

  it('separates different messages and call sites', () => {
    expect(dedupeKey(makeEvent())).not.toBe(dedupeKey(makeEvent({ message: 'other' })))
    expect(dedupeKey(makeEvent())).not.toBe(dedupeKey(makeEvent({ stack: 'E\n    at b (/b.ts:1:1)' })))
  })

  it('works without a stack', () => {
    expect(() => dedupeKey(makeEvent({ stack: undefined }))).not.toThrow()
  })
})

describe('EventQueue', () => {
  it('buffers until the batch size is reached', () => {
    const send = vi.fn(() => true)
    const queue = new EventQueue({ send, batchSize: 3, dedupeWindowMs: 0 })

    queue.add(makeEvent({ message: 'a' }))
    queue.add(makeEvent({ message: 'b' }))
    expect(send).not.toHaveBeenCalled()

    queue.add(makeEvent({ message: 'c' }))
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![0]).toHaveLength(3)
  })

  it('sends what is queued on an explicit flush', () => {
    const send = vi.fn(() => true)
    const queue = new EventQueue({ send, batchSize: 100 })

    queue.add(makeEvent())
    queue.flush()

    expect(send).toHaveBeenCalledOnce()
  })

  it('does nothing when flushed empty', () => {
    const send = vi.fn(() => true)

    new EventQueue({ send }).flush()

    expect(send).not.toHaveBeenCalled()
  })

  it('collapses the same fault reported from several sources', () => {
    const now = 1_000
    const send = vi.fn(() => true)
    const queue = new EventQueue({ send, batchSize: 100, now: () => now })

    // Vue's handler, window.onerror and unhandledrejection all see one throw.
    expect(queue.add(makeEvent())).toBe(true)
    expect(queue.add(makeEvent())).toBe(false)
    expect(queue.add(makeEvent())).toBe(false)

    queue.flush()
    expect(send.mock.calls[0]![0]).toHaveLength(1)
  })

  it('accepts the same fault again once the window passes', () => {
    let now = 1_000
    const queue = new EventQueue({ send: () => true, batchSize: 100, dedupeWindowMs: 5_000, now: () => now })

    expect(queue.add(makeEvent())).toBe(true)

    now += 6_000
    expect(queue.add(makeEvent())).toBe(true)
  })

  it('keeps distinct faults apart while de-duplicating', () => {
    const send = vi.fn(() => true)
    const queue = new EventQueue({ send, batchSize: 100 })

    queue.add(makeEvent({ message: 'a' }))
    queue.add(makeEvent({ message: 'b' }))
    queue.flush()

    expect(send.mock.calls[0]![0]).toHaveLength(2)
  })

  it('stops accepting events once the rate limit is hit', () => {
    const now = 1_000
    const queue = new EventQueue({
      send: () => true,
      batchSize: 1_000,
      dedupeWindowMs: 0,
      rateLimit: 5,
      now: () => now,
    })

    for (let i = 0; i < 5; i++) {
      expect(queue.add(makeEvent({ message: `m${i}` }))).toBe(true)
    }

    expect(queue.add(makeEvent({ message: 'overflow' }))).toBe(false)
  })

  it('resumes after the rate window rolls over', () => {
    let now = 1_000
    const queue = new EventQueue({
      send: () => true,
      batchSize: 1_000,
      dedupeWindowMs: 0,
      rateLimit: 2,
      rateWindowMs: 60_000,
      now: () => now,
    })

    queue.add(makeEvent({ message: 'a' }))
    queue.add(makeEvent({ message: 'b' }))
    expect(queue.add(makeEvent({ message: 'c' }))).toBe(false)

    now += 61_000
    expect(queue.add(makeEvent({ message: 'd' }))).toBe(true)
  })

  it('retains a batch the transport refused', () => {
    let ok = false
    const queue = new EventQueue({ send: () => ok, batchSize: 100 })

    queue.add(makeEvent())
    queue.flush()
    expect(queue.size).toBe(1)

    ok = true
    queue.flush()
    expect(queue.size).toBe(0)
  })

  it('bounds what it retains across repeated failures', () => {
    let now = 0
    const queue = new EventQueue({
      send: () => false,
      batchSize: 2,
      dedupeWindowMs: 0,
      rateLimit: 1_000,
      now: () => now++,
    })

    for (let i = 0; i < 50; i++) {
      queue.add(makeEvent({ message: `m${i}` }))
    }

    expect(queue.size).toBeLessThanOrEqual(4)
  })
})
