/**
 * Reading a time window from a query string.
 *
 * Shared because two endpoints answer over the same window and had grown two
 * copies of the same clamp — and because `/api/overview` takes *hours* while
 * these take milliseconds, which is exactly the kind of quiet disagreement
 * that makes two screens report different numbers for the same period.
 */

const DAY_MS = 24 * 60 * 60 * 1_000

/** Bounded to the retention range; a huge window is a slow scan, not an error. */
export function toWindow(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DAY_MS
  }

  return Math.min(parsed, 90 * DAY_MS)
}
