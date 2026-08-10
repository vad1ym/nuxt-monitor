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
