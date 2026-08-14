/** Compact "how long ago", which is how you read an error list. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1_000)

  if (seconds < 60) {
    return 'just now'
  }

  const minutes = Math.round(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.round(hours / 24)

  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString()
}

export function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

/**
 * A byte count as somebody would say it out loud.
 *
 * Binary units, since this describes a file on disk and the ceiling it is
 * measured against is configured in megabytes.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1_024)))
  const value = bytes / 1_024 ** power

  // One decimal below 10 — "1.4 MB" reads better than "1 MB" — and none above,
  // where the extra digit is noise.
  return `${value < 10 && power > 0 ? value.toFixed(1) : Math.round(value)} ${units[power]}`
}

/**
 * A duration as somebody would say it.
 *
 * Milliseconds up to a second, because that is the range where the digits
 * carry the meaning — 3ms and 900ms are different stories. Past that the
 * precision stops mattering and the magnitude starts: nobody investigating a
 * 31-second request needs to know it was 31,402.
 *
 * Shared rather than kept beside the one screen that first needed it: the
 * latency tiles render the same kind of number, and two formatters would
 * eventually disagree about where the decimal goes — on one screen, in two
 * places, about the same quantity.
 */
export function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${Math.round(ms)} ms`
  }

  const seconds = ms / 1_000

  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`
}

/**
 * Server errors read as 5xx-or-not; 4xx is usually someone else's problem.
 *
 * Here rather than beside one of its callers because the list and the detail
 * page both colour the same badge, and a status that is red on one screen and
 * amber on the other is a screen contradicting itself about how bad something
 * is.
 */
export function statusColor(status: number): 'error' | 'warning' | 'neutral' {
  if (status >= 500) {
    return 'error'
  }

  return status >= 400 ? 'warning' : 'neutral'
}
