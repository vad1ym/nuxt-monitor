import { describe, expect, it } from 'vitest'
import { callSiteStack, normalizeGroup, normalizeLevel } from './exception'

describe('normalizeLevel', () => {
  it('accepts the four levels', () => {
    for (const level of ['info', 'warning', 'error', 'critical'] as const) {
      expect(normalizeLevel(level)).toBe(level)
    }
  })

  it('falls back to error for anything else', () => {
    // Not to `info`: a report whose level was mistyped is more likely to be
    // something that matters than something that does not, and defaulting it
    // quiet is how it goes unseen.
    expect(normalizeLevel('urgent')).toBe('error')
    expect(normalizeLevel(undefined)).toBe('error')
    expect(normalizeLevel(3)).toBe('error')
  })
})

describe('normalizeGroup', () => {
  it('keeps an identifier-shaped name', () => {
    expect(normalizeGroup('payments')).toBe('payments')
    expect(normalizeGroup('data-integrity')).toBe('data-integrity')
    expect(normalizeGroup('  billing  ')).toBe('billing')
  })

  it('rejects anything that is not one', () => {
    // These become a column value, a filter and a routing key in somebody's
    // config file. A group with a space in it cannot be matched reliably
    // against a rule typed by hand.
    expect(normalizeGroup('two words')).toBeUndefined()
    expect(normalizeGroup('')).toBeUndefined()
    expect(normalizeGroup(42)).toBeUndefined()
    expect(normalizeGroup(undefined)).toBeUndefined()
  })

  it('bounds the length', () => {
    expect(normalizeGroup('a'.repeat(200))).toHaveLength(64)
  })
})

describe('callSiteStack', () => {
  it('drops our own frames so the top one is the caller', () => {
    // The top application frame is part of the fingerprint. Leaving our frames
    // on would make every manual report in an application group into one
    // issue, which is the single worst outcome for this feature.
    function caller(): string | undefined {
      return callSiteStack(1)
    }

    const stack = caller()

    expect(stack).toBeTruthy()
    expect(stack!.split('\n')[1]).toContain('caller')
  })

  it('keeps a first line, so parsers that skip it still work', () => {
    // `topFrame` and `culpritOf` both drop line one as the message.
    expect(callSiteStack()!.split('\n')[0]).toContain('MonitorException')
  })
})
