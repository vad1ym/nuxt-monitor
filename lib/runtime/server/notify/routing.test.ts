import { describe, expect, it } from 'vitest'
import type { MonitorAlert, MonitorChannelOptions, MonitorIssue } from '../../../types'
import { accepts, alertsFor } from './routing'

const NOW = 1_700_000_000_000

function alert(issue: Partial<MonitorIssue> = {}, reason: MonitorAlert['reason'] = 'new-issue'): MonitorAlert {
  return {
    reason,
    at: NOW,
    issue: {
      fingerprint: 'abc',
      type: 'TypeError',
      message: 'boom',
      side: 'server',
      count: 1,
      firstSeen: NOW,
      lastSeen: NOW,
      resolved: false,
      ignored: false,
      ...issue,
    },
  }
}

function channel(extra: Partial<MonitorChannelOptions> = {}): MonitorChannelOptions {
  return { type: 'webhook', url: 'https://hooks.test/a', ...extra } as MonitorChannelOptions
}

describe('an unfiltered channel', () => {
  it('takes everything, which is the default', () => {
    expect(accepts(channel(), alert())).toBe(true)
    expect(accepts(channel(), alert({ manual: true, group: 'payments', level: 'info' }))).toBe(true)
  })
})

describe('groups', () => {
  it('keeps only the groups it named', () => {
    const payments = channel({ groups: ['payments'] })

    expect(accepts(payments, alert({ manual: true, group: 'payments' }))).toBe(true)
    expect(accepts(payments, alert({ manual: true, group: 'auth' }))).toBe(false)
  })

  it('does not receive caught errors', () => {
    // A caught error carries no group, and naming a group is a statement about
    // what this channel is for. A payments chat that also gets every TypeError
    // in the app is a general channel with extra steps.
    expect(accepts(channel({ groups: ['payments'] }), alert())).toBe(false)
  })

  it('accepts any of several named groups', () => {
    const both = channel({ groups: ['payments', 'data-integrity'] })

    expect(accepts(both, alert({ manual: true, group: 'data-integrity' }))).toBe(true)
  })
})

describe('minLevel', () => {
  it('drops anything below the floor', () => {
    const urgent = channel({ minLevel: 'critical' })

    expect(accepts(urgent, alert({ manual: true, level: 'critical' }))).toBe(true)
    expect(accepts(urgent, alert({ manual: true, level: 'warning' }))).toBe(false)
  })

  it('treats a caught error as `error`', () => {
    // Not as unset: `minLevel: 'warning'` would otherwise silently drop every
    // genuine exception, which is the opposite of raising a floor.
    expect(accepts(channel({ minLevel: 'warning' }), alert())).toBe(true)
    expect(accepts(channel({ minLevel: 'critical' }), alert())).toBe(false)
  })
})

describe('a test alert', () => {
  it('reaches a channel whatever its filters say', () => {
    // A test checks that this channel works. Filtering it would make a silent
    // test indistinguishable from a broken one.
    const filtered = channel({ groups: ['payments'], minLevel: 'critical' })

    expect(accepts(filtered, alert({}, 'test'))).toBe(true)
  })
})

describe('alertsFor', () => {
  it('narrows a grouped batch to what this channel wants', () => {
    const batch = [
      alert({ manual: true, group: 'payments', level: 'critical' }),
      alert({ manual: true, group: 'auth', level: 'critical' }),
      alert(),
    ]

    expect(alertsFor(channel({ groups: ['payments'] }), batch)).toHaveLength(1)
    expect(alertsFor(channel(), batch)).toHaveLength(3)
  })
})
