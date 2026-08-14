import { describe, expect, it } from 'vitest'
import { BOUNDS, bucketFor, labelFor, percentile } from './latency'

/**
 * The histogram behind the latency figures.
 *
 * What is worth testing is not that counting works — it is that the summary
 * refuses to invent numbers. A percentile read off an empty distribution, or
 * one asked about the unbounded tail, has to answer honestly or the whole
 * feature reports fiction with a straight face.
 */

/** A distribution built from readings, the way the store accumulates one. */
function histogram(...readings: number[]): Map<string, number> {
  const counts = new Map<string, number>()

  for (const ms of readings) {
    const label = labelFor(bucketFor(ms))

    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return counts
}

describe('bucketing', () => {
  it('puts a reading in the first bucket it does not exceed', () => {
    // Upper-inclusive, so a reading exactly on a bound belongs to that bucket
    // rather than the next one.
    expect(labelFor(bucketFor(5))).toBe('5')
    expect(labelFor(bucketFor(6))).toBe('10')
    expect(labelFor(bucketFor(100))).toBe('100')
    expect(labelFor(bucketFor(101))).toBe('150')
  })

  it('collects everything past the last bound into an unbounded tail', () => {
    // The bucket that cannot overflow. A 90-second request and a 10-minute one
    // are both "far too slow", and the exact figure changes no decision.
    expect(labelFor(bucketFor(30_001))).toBe('inf')
    expect(labelFor(bucketFor(600_000))).toBe('inf')
  })

  it('labels buckets by their bound rather than their position', () => {
    // So a stored row keeps its meaning if the bucket list ever changes. An
    // index would silently start naming a different range.
    expect(labelFor(0)).toBe(String(BOUNDS[0]))
    expect(labelFor(BOUNDS.length - 1)).toBe(String(BOUNDS.at(-1)))
  })

  it('starts fast requests in the first bucket', () => {
    expect(labelFor(bucketFor(0))).toBe('5')
    expect(labelFor(bucketFor(1))).toBe('5')
  })
})

describe('percentiles', () => {
  it('reports no number at all for an empty distribution', () => {
    // "No data" and "instant" are different answers, and only one of them is
    // reassuring. Returning 0 would be the reassuring one and a lie.
    expect(percentile(new Map(), 0.95)).toBeUndefined()
  })

  it('finds the median of a uniform distribution', () => {
    const counts = histogram(...Array.from({ length: 100 }).fill(90))

    // Everything in the 75–100 bucket, so the median is inside it.
    expect(percentile(counts, 0.5)).toBeGreaterThan(75)
    expect(percentile(counts, 0.5)).toBeLessThanOrEqual(100)
  })

  it('separates the tail from the body, which a mean cannot', () => {
    // The whole reason this is a histogram. Ninety-five fast requests and five
    // very slow ones: the mean lands around 500 ms, describing nobody's
    // experience, while the p50 and p95 tell the true story of both groups.
    const counts = histogram(
      ...Array.from({ length: 95 }).fill(20),
      ...Array.from({ length: 5 }).fill(9_000),
    )

    expect(percentile(counts, 0.5)).toBeLessThanOrEqual(25)
    expect(percentile(counts, 0.99)).toBeGreaterThan(4_000)
  })

  it('interpolates within a bucket rather than snapping to its bound', () => {
    // Without interpolation a p95 could only ever answer with one of eighteen
    // fixed numbers, so it would jump between two of them and read as a fault
    // in the tool rather than a change in the application.
    const counts = histogram(...Array.from({ length: 1_000 }, (_, i) => 600 + i % 400))
    const p50 = percentile(counts, 0.5)!
    const p95 = percentile(counts, 0.95)!

    expect(p95).toBeGreaterThan(p50)
    // Landing on a raw bound for both would mean no interpolation happened.
    expect(BOUNDS.includes(p50) && BOUNDS.includes(p95)).toBe(false)
  })

  it('reports the tail as "at least the last bound"', () => {
    // The overflow bucket has no upper edge to interpolate towards, so the
    // only honest answer is the bound it is known to exceed. Infinity would be
    // useless and an invented ceiling would be a lie.
    const counts = histogram(...Array.from({ length: 10 }).fill(120_000))

    expect(percentile(counts, 0.95)).toBe(BOUNDS.at(-1))
  })

  it('rises monotonically across quantiles', () => {
    const counts = histogram(
      ...Array.from({ length: 50 }).fill(30),
      ...Array.from({ length: 30 }).fill(300),
      ...Array.from({ length: 20 }).fill(3_000),
    )

    const p50 = percentile(counts, 0.5)!
    const p95 = percentile(counts, 0.95)!
    const p99 = percentile(counts, 0.99)!

    expect(p50).toBeLessThanOrEqual(p95)
    expect(p95).toBeLessThanOrEqual(p99)
  })

  it('handles a single reading', () => {
    expect(percentile(histogram(42), 0.5)).toBeGreaterThan(0)
  })
})
