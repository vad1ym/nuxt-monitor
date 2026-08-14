/**
 * How long requests take, stored as a histogram rather than as readings.
 *
 * The gap this closes is the one that separates an error tracker from a
 * monitor: until now nothing was recorded unless it *threw*. An application
 * answering 200 in eight seconds looked perfectly healthy here — the error
 * rate said zero, the issue list was empty — while being unusable for
 * everybody trying to use it. Degradation without failure was invisible.
 *
 * A histogram rather than the readings themselves, because the alternatives
 * are both wrong at the scale this has to work at. Keeping every duration is a
 * row per request, which is the log this module deliberately is not. Keeping a
 * mean is worse than nothing: latency distributions have long tails, the mean
 * sits in the empty space between the fast majority and the slow tail, and it
 * moves last precisely when the tail is what broke. A p95 is the number people
 * act on, and a p95 needs the shape.
 *
 * The cost is bounded and known: `BOUNDS.length + 1` counters per route per
 * minute, whatever the traffic — the same shape as the status-class counters
 * beside it, which is why this can ride in the same table.
 */

/**
 * Bucket edges in milliseconds, roughly a third of an order of magnitude apart.
 *
 * Chosen rather than computed so the boundaries are readable numbers a person
 * recognises — 100 ms, 1 s, 30 s — and so they can never drift between the
 * writer and the reader. Resolution is finest between 50 ms and 2 s, which is
 * where the answer to "is this slow" actually lives; past 10 s the exact figure
 * stops mattering because the verdict is the same either way.
 *
 * A reading lands in the first bucket whose bound it does not exceed, so the
 * bounds are upper-inclusive and the final bucket is everything above the last
 * one — an unbounded tail that cannot overflow.
 */
export const BOUNDS = [
  5,
  10,
  25,
  50,
  75,
  100,
  150,
  250,
  400,
  600,
  1_000,
  1_500,
  2_500,
  4_000,
  6_000,
  10_000,
  30_000,
]

/** The bucket a duration belongs to. The last index is "slower than them all". */
export function bucketFor(ms: number): number {
  for (let index = 0; index < BOUNDS.length; index++) {
    if (ms <= BOUNDS[index]!) {
      return index
    }
  }

  return BOUNDS.length
}

/**
 * A label for one bucket, for storing and for reading back.
 *
 * The bound itself rather than an ordinal, so the stored value survives a
 * change to this list: adding a bucket edge in a later version leaves old rows
 * meaning exactly what they meant when written, where an index would silently
 * re-point at a different range. The overflow bucket is `inf`.
 */
export function labelFor(index: number): string {
  return index < BOUNDS.length ? String(BOUNDS[index]) : 'inf'
}

/** The upper bound a label names. `Infinity` for the tail. */
export function boundOf(label: string): number {
  return label === 'inf' ? Number.POSITIVE_INFINITY : Number(label)
}

/**
 * A percentile, read out of bucket counts.
 *
 * Interpolated within the bucket the percentile falls in rather than returned
 * as the bucket's upper bound, because the bounds are far apart by design: a
 * p95 that can only ever answer "1000" or "1500" is a number that jumps
 * between two values and looks like a fault in the tool. Interpolation is
 * linear, which assumes readings are spread evenly inside a bucket — untrue in
 * detail, and close enough at this resolution.
 *
 * Returns undefined for an empty distribution: "no data" and "instant" are
 * different answers and only one of them is reassuring.
 */
export function percentile(counts: Map<string, number>, quantile: number): number | undefined {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)

  if (!total) {
    return undefined
  }

  const target = total * quantile
  const sorted = [...counts.entries()].sort((a, b) => boundOf(a[0]) - boundOf(b[0]))

  let seen = 0

  for (const [label, count] of sorted) {
    const upper = boundOf(label)

    if (seen + count >= target) {
      // The tail has no upper edge to interpolate towards, so the only honest
      // answer is the bound it is known to exceed. Infinity would be useless
      // and an invented ceiling would be a lie.
      if (!Number.isFinite(upper)) {
        return BOUNDS[BOUNDS.length - 1]!
      }

      const lower = lowerBoundOf(upper)
      const within = count ? (target - seen) / count : 0

      return Math.round(lower + (upper - lower) * within)
    }

    seen += count
  }

  return Math.round(boundOf(sorted[sorted.length - 1]![0]))
}

/**
 * The bucket edge below a given one.
 *
 * Read from `BOUNDS` rather than remembered from the previous row of the
 * histogram, which is the same thing only when every bucket is present. Real
 * distributions are sparse — a route that answers in 20 ms and occasionally in
 * 4 s has nothing in between — and taking the last row's bound as this one's
 * floor made the interpolation span the empty gap, placing the median far
 * below the bucket it actually fell in.
 */
function lowerBoundOf(upper: number): number {
  const index = BOUNDS.indexOf(upper)

  return index > 0 ? BOUNDS[index - 1]! : 0
}
