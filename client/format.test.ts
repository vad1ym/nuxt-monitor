import { describe, expect, it } from 'vitest'
import { formatBytes, relativeTime } from './format'

describe('relativeTime', () => {
  const now = new Date('2026-08-08T12:00:00Z').getTime()

  it('describes recent moments loosely', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now')
    expect(relativeTime(now - 59_000, now)).toBe('just now')
  })

  it('scales through minutes, hours and days', () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  })

  it('falls back to a date once it is no longer useful as a duration', () => {
    expect(relativeTime(now - 200 * 86_400_000, now)).toMatch(/\d/)
    expect(relativeTime(now - 200 * 86_400_000, now)).not.toContain('ago')
  })
})

describe('formatBytes', () => {
  it('reads as somebody would say it', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1_024)).toBe('1.0 KB')
    expect(formatBytes(1_536)).toBe('1.5 KB')
    expect(formatBytes(256 * 1_024 * 1_024)).toBe('256 MB')
    expect(formatBytes(1_024 ** 3)).toBe('1.0 GB')
  })

  it('does not produce nonsense for absent or negative values', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})
