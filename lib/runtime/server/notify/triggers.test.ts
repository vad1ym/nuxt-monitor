import { describe, expect, it } from 'vitest'
import type { MonitorIssue } from '../../../types'
import type { IssueState } from './triggers'
import { evaluate, evaluateErrorRate } from './triggers'

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

/**
 * "It got faster", which the count-based triggers cannot express.
 *
 * An issue that has ticked along for a week and does four hundred in a minute
 * has crossed no new threshold — it passed 100 and 1000 long ago — so without
 * this nothing is said at the moment something actually changed.
 */
describe('spike', () => {
  /** Ten an hour before; the flush adds 60 in one minute. That is ×360. */
  function spiking(overrides: Partial<IssueState> = {}): IssueState {
    return state({
      previousCount: 100,
      ratePerMinute: 10 / 60,
      addedCount: 60,
      spanMs: 60_000,
      ...overrides,
    })
  }

  it('is off unless asked for', () => {
    expect(evaluate(issue({ count: 160 }), spiking(), undefined, NOW)?.reason).not.toBe('spike')
  })

  it('fires when the rate jumps', () => {
    const alert = evaluate(issue({ count: 160 }), spiking(), { spike: true }, NOW)

    expect(alert?.reason).toBe('spike')
    expect(alert?.factor).toBe(360)
  })

  it('stays quiet when the rate is merely normal', () => {
    // Same rate as before: 10 an hour, and the flush adds one in six minutes.
    const steady = spiking({ addedCount: 1, spanMs: 6 * 60_000 })

    expect(evaluate(issue({ count: 101 }), steady, { spike: true }, NOW)?.reason).not.toBe('spike')
  })

  it('does not claim a spike from a handful of occurrences', () => {
    // ×180 by arithmetic, nothing by judgement: three occurrences in a minute
    // from an issue that used to manage one an hour.
    const tiny = spiking({ addedCount: 3, spanMs: 60_000 })

    expect(evaluate(issue({ count: 103 }), tiny, { spike: true }, NOW)?.reason).not.toBe('spike')
  })

  it('needs history to compare against', () => {
    // A brand-new issue has no usual rate. `newIssue` already covers it, and
    // dividing by an absent baseline would call every new issue a spike.
    const fresh = spiking({ ratePerMinute: undefined })

    expect(evaluate(issue({ count: 60 }), fresh, { spike: true }, NOW)?.reason).not.toBe('spike')
  })

  it('honours a custom factor', () => {
    // ×3 exactly: 20 an hour before, 60 in one minute is ×180 — so a threshold
    // above that must not fire.
    expect(evaluate(issue({ count: 160 }), spiking(), { spike: { factor: 1_000 } }, NOW)?.reason)
      .not.toBe('spike')
  })

  it('beats a threshold crossed in the same flush', () => {
    // Both are true of an issue going vertical. "Five times its usual rate"
    // says something changed just now; "passed 100" says a total got bigger,
    // which for a busy issue is true every day.
    const alert = evaluate(issue({ count: 160 }), spiking({ previousCount: 40 }), {
      spike: true,
      thresholds: [100],
    }, NOW)

    expect(alert?.reason).toBe('spike')
  })

  it('never fires for an ignored issue', () => {
    const alert = evaluate(issue({ count: 160, ignored: true }), spiking(), { spike: true }, NOW)

    expect(alert).toBeUndefined()
  })
})

/**
 * The application-wide trigger.
 *
 * The only one that can fire when no single issue is remarkable: fifty small
 * faults, each under every threshold, are still a checkout nobody completes.
 */
describe('error rate', () => {
  it('is off unless asked for', () => {
    expect(evaluateErrorRate({ failed: 90, total: 100 }, undefined, NOW)).toBeUndefined()
  })

  it('fires above the configured fraction', () => {
    const alert = evaluateErrorRate({ failed: 30, total: 100 }, { errorRate: 0.25 }, NOW)

    expect(alert?.reason).toBe('error-rate')
    expect(alert?.rate).toEqual({ failed: 30, total: 100 })
    // It is about the application, so it names no issue — pointing at one
    // would blame a symptom that may not be the cause.
    expect(alert?.issue).toBeUndefined()
  })

  it('stays quiet below it', () => {
    expect(evaluateErrorRate({ failed: 10, total: 100 }, { errorRate: 0.25 }, NOW)).toBeUndefined()
  })

  it('ignores a quiet period, where a ratio means nothing', () => {
    // Three failures out of four requests at 4am is 75% and is not an outage.
    // Without a floor the trigger is loudest when the application is quietest.
    expect(evaluateErrorRate({ failed: 3, total: 4 }, { errorRate: 0.25 }, NOW)).toBeUndefined()
  })

  it('honours a custom minimum', () => {
    const alert = evaluateErrorRate(
      { failed: 3, total: 4 },
      { errorRate: { above: 0.25, minimumRequests: 4 } },
      NOW,
    )

    expect(alert?.reason).toBe('error-rate')
  })

  it('survives a window with no traffic at all', () => {
    expect(evaluateErrorRate({ failed: 0, total: 0 }, { errorRate: 0.25 }, NOW)).toBeUndefined()
  })
})
