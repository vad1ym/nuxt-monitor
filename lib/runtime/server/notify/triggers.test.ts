import { describe, expect, it } from 'vitest'
import type { MonitorIssue } from '../../../types'
import type { IssueState } from './triggers'
import { evaluate } from './triggers'

const NOW = 1_700_000_000_000

function issue(overrides: Partial<MonitorIssue> = {}): MonitorIssue {
  return {
    fingerprint: 'abc',
    type: 'TypeError',
    message: 'x is not a function',
    side: 'server',
    count: 1,
    firstSeen: NOW,
    lastSeen: NOW,
    resolved: false,
    ignored: false,
    ...overrides,
  }
}

function state(overrides: Partial<IssueState> = {}): IssueState {
  return { previousCount: 1, wasResolved: false, alertedCount: 0, alertedAt: 0, ...overrides }
}

describe('evaluate', () => {
  it('alerts on a fingerprint never seen before', () => {
    const alert = evaluate(issue(), state({ previousCount: 0 }), undefined, NOW)

    expect(alert?.reason).toBe('new-issue')
  })

  it('alerts when a resolved issue happens again', () => {
    const alert = evaluate(issue({ count: 5 }), state({ wasResolved: true }), undefined, NOW)

    expect(alert?.reason).toBe('regression')
  })

  it('calls a brand-new issue new, not a regression', () => {
    // A row that does not exist is not resolved, but a caller could pass both;
    // the count is what distinguishes them and it must win.
    const alert = evaluate(issue(), state({ previousCount: 0, wasResolved: true }), undefined, NOW)

    expect(alert?.reason).toBe('new-issue')
  })

  it('says nothing about an ordinary repeat', () => {
    expect(evaluate(issue({ count: 4 }), state({ previousCount: 3 }), undefined, NOW))
      .toBeUndefined()
  })

  it('never alerts about an ignored issue', () => {
    // Ignored means "noisy and not mine", and noisy is exactly what fires
    // triggers. Alerting anyway would make the button meaningless.
    expect(evaluate(issue({ ignored: true }), state({ previousCount: 0 }), undefined, NOW))
      .toBeUndefined()
  })

  it('alerts once per threshold crossed', () => {
    const crossing = evaluate(issue({ count: 10 }), state({ previousCount: 9 }), undefined, NOW)

    expect(crossing?.reason).toBe('threshold')
    expect(crossing?.threshold).toBe(10)

    // Same threshold, already announced: silent.
    expect(evaluate(issue({ count: 11 }), state({ previousCount: 10, alertedCount: 10 }), undefined, NOW))
      .toBeUndefined()
  })

  it('reports the highest threshold when a flush jumps several', () => {
    // 4 to 400 in one flush passes both 10 and 100. Reporting 10 would describe
    // the smaller of two facts, and reporting both would be two messages.
    const alert = evaluate(issue({ count: 400 }), state({ previousCount: 4 }), undefined, NOW)

    expect(alert?.threshold).toBe(100)
  })

  it('honours a configured threshold list', () => {
    const options = { thresholds: [3] }

    expect(evaluate(issue({ count: 3 }), state({ previousCount: 2 }), options, NOW)?.threshold)
      .toBe(3)
    expect(evaluate(issue({ count: 10 }), state({ previousCount: 9, alertedCount: 3 }), options, NOW))
      .toBeUndefined()
  })

  it('can be turned off trigger by trigger', () => {
    expect(evaluate(issue(), state({ previousCount: 0 }), { newIssue: false }, NOW))
      .toBeUndefined()
    expect(evaluate(issue({ count: 5 }), state({ wasResolved: true }), { regression: false }, NOW))
      .toBeUndefined()
    expect(evaluate(issue({ count: 10 }), state({ previousCount: 9 }), { thresholds: [] }, NOW))
      .toBeUndefined()
  })

  it('prefers a regression to a threshold when both apply', () => {
    // One event, one message: the interesting fact is that a fix did not hold.
    const alert = evaluate(
      issue({ count: 10 }),
      state({ previousCount: 9, wasResolved: true }),
      undefined,
      NOW,
    )

    expect(alert?.reason).toBe('regression')
  })
})
