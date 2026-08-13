import { describe, expect, it } from 'vitest'
import { isQuiet, localTime, parseClock } from './quiet'

/** A fixed local time, so the tests do not depend on when they run. */
function at(hours: number, minutes = 0, day = 3): number {
  // 2026-01-07 was a Wednesday; `day` shifts from there.
  return new Date(2026, 0, 7 + (day - 3), hours, minutes).getTime()
}

describe('parseClock', () => {
  it('reads HH:MM as minutes since midnight', () => {
    expect(parseClock('22:30')).toBe(22 * 60 + 30)
    expect(parseClock('00:00')).toBe(0)
    expect(parseClock(' 7:05 ')).toBe(7 * 60 + 5)
  })

  it('rejects what is not a time', () => {
    expect(parseClock('24:00')).toBeUndefined()
    expect(parseClock('12:60')).toBeUndefined()
    expect(parseClock('noon')).toBeUndefined()
    expect(parseClock('')).toBeUndefined()
  })
})

describe('isQuiet', () => {
  it('is never quiet without a window', () => {
    expect(isQuiet(undefined, at(3))).toBe(false)
  })

  it('covers a same-day window, end exclusive', () => {
    const window = { from: '09:00', to: '17:00' }

    expect(isQuiet(window, at(8, 59))).toBe(false)
    expect(isQuiet(window, at(9))).toBe(true)
    expect(isQuiet(window, at(16, 59))).toBe(true)
    expect(isQuiet(window, at(17))).toBe(false)
  })

  it('wraps past midnight, which is what a night window does', () => {
    const window = { from: '22:00', to: '07:00' }

    expect(isQuiet(window, at(21, 59))).toBe(false)
    expect(isQuiet(window, at(22))).toBe(true)
    expect(isQuiet(window, at(0))).toBe(true)
    expect(isQuiet(window, at(6, 59))).toBe(true)
    expect(isQuiet(window, at(7))).toBe(false)
  })

  it('sends rather than silences when the window is malformed', () => {
    // The alternative — treating a typo as "always quiet" — is a monitoring
    // tool that has gone silent in a way nobody can see.
    expect(isQuiet({ from: 'evening', to: '07:00' }, at(3))).toBe(false)
  })

  it('applies days to the night the window started on', () => {
    // Friday night, 22:00 through Saturday 07:00. Read naively, the small hours
    // of Saturday fall on a day the window does not list and the silence ends
    // at midnight — the half of the night the rule was written for.
    const window = { from: '22:00', to: '07:00', days: [5] }

    expect(isQuiet(window, at(23, 0, 5))).toBe(true)
    expect(isQuiet(window, at(2, 0, 6))).toBe(true)
    expect(isQuiet(window, at(23, 0, 4))).toBe(false)
  })

  it('reads the window in the configured zone', () => {
    // 02:00 UTC is 04:00 in Kyiv (UTC+2 in January), inside a 22:00–07:00
    // window either way — so the discriminating case is one that falls inside
    // in one zone and outside in the other.
    const window = { from: '22:00', to: '07:00', timezone: 'Europe/Kyiv' }
    const utcMorning = Date.UTC(2026, 0, 7, 6, 0)

    // 06:00 UTC is 08:00 in Kyiv: quiet has ended there, not yet in UTC.
    expect(isQuiet(window, utcMorning)).toBe(false)
    expect(isQuiet({ from: '22:00', to: '07:00', timezone: 'UTC' }, utcMorning)).toBe(true)
  })

  it('falls back to the server zone when the name is not a zone', () => {
    expect(() => isQuiet({ from: '00:00', to: '23:59', timezone: 'Mars/Olympus' }, at(3)))
      .not.toThrow()
  })
})

describe('localTime', () => {
  it('reports the weekday in the target zone', () => {
    // 23:30 UTC on a Wednesday is already Thursday in Kyiv.
    const { day } = localTime(Date.UTC(2026, 0, 7, 23, 30), 'Europe/Kyiv')

    expect(day).toBe(4)
  })
})
