import { describe, expect, it } from 'vitest'
import { Sampler } from './sampling'

/** A clock the test moves by hand, so no window depends on wall time. */
function clock(start = 1_000_000): { now: () => number, advance: (ms: number) => void } {
  let value = start

  return { now: () => value, advance: (ms) => { value += ms } }
}

describe('when it is off', () => {
  it('admits everything, which is the default', () => {
    const sampler = new Sampler()

    expect(sampler.active).toBe(false)
    expect(Array.from({ length: 1_000 }, () => sampler.admit('a')).every(Boolean)).toBe(true)
    expect(sampler.pending).toBe(0)
  })
})

describe('the burst', () => {
  it('stores the first occurrences whole', () => {
    const sampler = new Sampler({ burst: 5, keepOneIn: 100 })

    for (let i = 0; i < 5; i++) {
      expect(sampler.admit('a')).toBe(true)
    }

    expect(sampler.admit('a')).toBe(false)
  })

  it('is per issue, so one loud issue does not silence a quiet one', () => {
    // The failure this whole feature is about: a route failing constantly used
    // to push everything else out of the shared buffer.
    const sampler = new Sampler({ burst: 2, keepOneIn: 1_000 })

    sampler.admit('loud')
    sampler.admit('loud')
    expect(sampler.admit('loud')).toBe(false)

    // A different fault, first time seen: stored.
    expect(sampler.admit('quiet')).toBe(true)
  })

  it('starts again in the next window', () => {
    const time = clock()
    const sampler = new Sampler({ burst: 2, keepOneIn: 1_000, windowMs: 60_000, now: time.now })

    sampler.admit('a')
    sampler.admit('a')
    expect(sampler.admit('a')).toBe(false)

    time.advance(60_000)

    // An issue still happening an hour later deserves fresh detail: the stack
    // may have moved, and the old occurrences may already have been trimmed.
    expect(sampler.admit('a')).toBe(true)
  })
})

describe('the trickle past the burst', () => {
  it('keeps one in every `keepOneIn`', () => {
    const sampler = new Sampler({ burst: 1, keepOneIn: 5 })

    sampler.admit('a')

    const kept = Array.from({ length: 20 }, () => sampler.admit('a')).filter(Boolean)

    // Without a trickle the chart would show a fault stopping at the moment it
    // got bad enough to be sampled.
    expect(kept).toHaveLength(4)
  })
})

describe('keeping the count exact', () => {
  /**
   * The property the whole design turns on. Under-reporting how often
   * something happened is worse than not reporting it: 12 occurrences reads as
   * a curiosity where 40,000 reads as an emergency.
   */
  it('accounts for every occurrence it did not store', () => {
    const sampler = new Sampler({ burst: 10, keepOneIn: 50 })
    const total = 1_000

    let stored = 0

    for (let i = 0; i < total; i++) {
      if (sampler.admit('a')) {
        stored++
      }
    }

    const owed = sampler.drainPending()

    expect(stored + (owed.get('a') ?? 0)).toBe(total)
  })

  it('accounts for a spike that stops mid-window', () => {
    // The case a weight riding on "the next stored occurrence" would lose: the
    // next one never comes.
    const sampler = new Sampler({ burst: 1, keepOneIn: 1_000 })

    sampler.admit('a')
    sampler.admit('a')
    sampler.admit('a')

    expect(sampler.drainPending().get('a')).toBe(2)
  })

  it('does not hand the same occurrence out twice', () => {
    const sampler = new Sampler({ burst: 1, keepOneIn: 1_000 })

    sampler.admit('a')
    sampler.admit('a')

    expect(sampler.drainPending().get('a')).toBe(1)
    expect(sampler.drainPending().size).toBe(0)
  })

  it('carries a debt across a window boundary', () => {
    // A window rolling is not a reason to forget occurrences that happened.
    const time = clock()
    const sampler = new Sampler({ burst: 1, keepOneIn: 1_000, windowMs: 60_000, now: time.now })

    sampler.admit('a')
    sampler.admit('a')

    time.advance(60_000)
    sampler.admit('a')

    expect(sampler.drainPending().get('a')).toBe(1)
  })
})

describe('the ceiling on tracked issues', () => {
  it('forgets the oldest rather than growing without bound', () => {
    const sampler = new Sampler({ burst: 1, maxTracked: 10 })

    for (let i = 0; i < 50; i++) {
      sampler.admit(`issue-${i}`)
    }

    expect(sampler.tracked).toBeLessThanOrEqual(10)
  })

  it('errs towards storing, never towards losing a count', () => {
    // A forgotten bucket means a reset burst allowance — a few more events
    // written than needed. It must never mean an occurrence going uncounted.
    const sampler = new Sampler({ burst: 1, keepOneIn: 1_000, maxTracked: 2 })

    sampler.admit('a')
    sampler.admit('a')
    sampler.admit('b')
    sampler.admit('c')

    const owed = sampler.drainPending()
    const debt = [...owed.values()].reduce((sum, value) => sum + value, 0)

    // Whatever was evicted, nothing claims more occurrences than happened.
    expect(debt).toBeLessThanOrEqual(1)
  })
})
