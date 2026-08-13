import type { MonitorQuietHours } from '../../../types'

/**
 * When not to send.
 *
 * Kept apart from delivery because the whole of it is one predicate over a
 * clock, and a predicate over a clock is the kind of thing that is wrong in a
 * way nobody notices until the night it matters. Here it can be asked about
 * midnight, about a wrapping window and about a zone the server is not in,
 * without a database or a bot token in sight.
 */

/** `HH:MM` as minutes since midnight, or `undefined` when it is not that. */
export function parseClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())

  if (!match) {
    return undefined
  }

  const hours = Number(match[1])
  const minutes = Number(match[2])

  if (hours > 23 || minutes > 59) {
    return undefined
  }

  return hours * 60 + minutes
}

/**
 * Local wall-clock time in a named zone.
 *
 * Via `Intl` rather than an offset arithmetic of our own: the offset for a zone
 * is not a constant, it changes twice a year, and a window written as 22:00–07:00
 * would drift by an hour for half the year if it were computed from one.
 *
 * An unknown zone name falls back to the server's rather than throwing. A
 * misspelled timezone should cost the precision of the quiet window, not the
 * ability to alert at all.
 */
export function localTime(at: number, timezone?: string): { minutes: number, day: number } {
  const date = new Date(at)

  if (!timezone) {
    return { minutes: date.getHours() * 60 + date.getMinutes(), day: date.getDay() }
  }

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    }).formatToParts(date)

    const value = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    return {
      minutes: Number(value('hour')) * 60 + Number(value('minute')),
      day: Math.max(0, days.indexOf(value('weekday'))),
    }
  }
  catch {
    return { minutes: date.getHours() * 60 + date.getMinutes(), day: date.getDay() }
  }
}

/**
 * Whether `at` falls inside the configured silence.
 *
 * `from` is inclusive and `to` exclusive, and a window whose end is not after
 * its start wraps past midnight — which is what a night window always does, so
 * that case is the normal one rather than the exception.
 *
 * A malformed time silences nothing. The alternative, treating an unparseable
 * window as "always quiet", turns a typo into total silence from a monitoring
 * tool, and that failure is invisible precisely when it costs the most.
 */
export function isQuiet(quiet: MonitorQuietHours | undefined, at: number): boolean {
  if (!quiet) {
    return false
  }

  const from = parseClock(quiet.from)
  const to = parseClock(quiet.to)

  if (from === undefined || to === undefined) {
    return false
  }

  const { minutes, day } = localTime(at, quiet.timezone)

  // The day is the one the window *starts* on, so a Friday-night window still
  // covers the small hours of Saturday. Testing the current day against the
  // list after midnight would end the silence at 00:00 rather than at 07:00.
  const startDay = from <= to || minutes >= from ? day : (day + 6) % 7

  if (quiet.days && !quiet.days.includes(startDay)) {
    return false
  }

  return from <= to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to
}
