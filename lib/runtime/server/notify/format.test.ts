import { describe, expect, it } from 'vitest'
import type { MonitorAlert, MonitorIssue } from '../../../types'
import { formatMarkdown, formatText } from './format'

const NOW = 1_700_000_000_000
const DASHBOARD = 'https://app.example.com/_monitor'

function alert(overrides: Partial<MonitorIssue> = {}, reason: MonitorAlert['reason'] = 'new-issue'): MonitorAlert {
  return {
    reason,
    at: NOW,
    issue: {
      fingerprint: 'abc123',
      type: 'TypeError',
      message: 'cart.total is not a function',
      side: 'server',
      count: 1,
      firstSeen: NOW,
      lastSeen: NOW,
      resolved: false,
      ignored: false,
      ...overrides,
    },
  }
}

describe('formatText', () => {
  it('leads with what happened and names the error', () => {
    const message = formatText([alert({ culprit: 'cart.ts:12' })], DASHBOARD)

    expect(message).toContain('New issue')
    expect(message).toContain('TypeError')
    expect(message).toContain('cart.total is not a function')
    expect(message).toContain('at cart.ts:12')
  })

  it('links straight at the issue when there is only one', () => {
    expect(formatText([alert()], DASHBOARD))
      .toContain(`${DASHBOARD}/issues/abc123`)
  })

  it('links at the list when several are grouped', () => {
    const message = formatText([alert(), alert({ fingerprint: 'def' })], DASHBOARD)

    expect(message).toContain('2 × New issue')
    expect(message).not.toContain('/issues/')
  })

  it('counts mixed reasons rather than naming one of them', () => {
    const message = formatText([alert(), alert({}, 'regression')], DASHBOARD)

    expect(message).toContain('2 alerts')
  })

  it('summarises the tail rather than listing twenty', () => {
    const alerts = Array.from({ length: 8 }, (_, index) => alert({ fingerprint: `fp${index}` }))

    expect(formatText(alerts, DASHBOARD)).toContain('and 3 more')
  })

  it('says how many occurrences a threshold alert is about', () => {
    expect(formatText([alert({ count: 100 }, 'threshold')], DASHBOARD))
      .toContain('100 occurrences')
  })

  it('points a test alert at the dashboard, not at an issue that does not exist', () => {
    // The message somebody sends to confirm the setup works is the worst
    // possible place to hand them a 404.
    const message = formatText([alert({}, 'test')], DASHBOARD)

    expect(message).not.toContain('/issues/')
    expect(message).toContain(`Open dashboard: ${DASHBOARD}`)
  })

  it('omits the link when no dashboard URL is configured', () => {
    const message = formatText([alert()], '')

    expect(message).not.toContain('http')
    expect(message).toContain('TypeError')
  })

  it('collapses a multi-line message onto one line', () => {
    expect(formatText([alert({ message: 'broke\n  badly' })], DASHBOARD))
      .toContain('broke badly')
  })
})

describe('formatMarkdown', () => {
  it('escapes every character MarkdownV2 reserves', () => {
    // An unescaped `.` or `-` makes Telegram reject the whole message with a
    // 400 — and error messages are full of both.
    const message = formatMarkdown([alert({ message: 'v1.2-beta (failed) [here]' })], DASHBOARD)

    expect(message).toContain('v1\\.2\\-beta \\(failed\\) \\[here\\]')
  })

  it('leaves the markup it adds itself unescaped', () => {
    const message = formatMarkdown([alert()], DASHBOARD)

    expect(message.startsWith('*New issue*')).toBe(true)
    expect(message).toContain('`TypeError`')
    expect(message).toContain('[Open issue](https://app.example.com/_monitor/issues/abc123)')
  })

  it('escapes a URL by the link rule, not the text rule', () => {
    // Inside `(...)` MarkdownV2 reserves only `)` and `\`. Escaping the dots
    // too would leave backslashes the parser eats, and the link would point at
    // a different host than the one configured.
    const message = formatMarkdown([alert()], 'https://app.example.com/base(v2)')

    expect(message).toContain('(https://app.example.com/base(v2\\)/issues/abc123)')
  })

  it('escapes a backslash in the message body', () => {
    expect(formatMarkdown([alert({ message: 'C:\\path' })], DASHBOARD))
      .toContain('C:\\\\path')
  })
})

describe('an empty batch', () => {
  it('renders nothing rather than an empty headline', () => {
    expect(formatText([], DASHBOARD)).toBe('')
    expect(formatMarkdown([], DASHBOARD)).toBe('')
  })
})
