/**
 * Shaping for the error-over-time chart.
 *
 * Kept separate from the component because the interesting part is not the
 * drawing — it is filling the gaps. The API returns only buckets that had
 * events, so plotting them directly would draw an hour of silence as a
 * continuous line and hide exactly the pattern the chart exists to show.
 */

export interface TrendPoint {
  bucket: number
  server: number
  client: number
}

export interface ChartColumn {
  /** Bucket start, for the tooltip. */
  at: number
  server: number
  client: number
  total: number
  /** Height as a fraction of the tallest column, 0…1. */
  height: number
}

/**
 * Turns sparse buckets into a continuous series of `columns` bars.
 *
 * Buckets with no events become zero-height columns rather than being skipped,
 * so a gap reads as a gap.
 */
export function toColumns(
  points: TrendPoint[],
  options: { now: number, windowMs: number, columns?: number },
): ChartColumn[] {
  const columns = options.columns ?? 48
  const width = Math.max(1, Math.floor(options.windowMs / columns))
  const start = options.now - options.windowMs

  const buckets: ChartColumn[] = Array.from({ length: columns }, (_, index) => ({
    at: start + index * width,
    server: 0,
    client: 0,
    total: 0,
    height: 0,
  }))

  for (const point of points) {
    const index = Math.floor((point.bucket - start) / width)

    // Points outside the window are ignored rather than clamped into the edge
    // column, which would invent a spike that never happened.
    if (index < 0 || index >= columns) {
      continue
    }

    const column = buckets[index]!

    column.server += point.server
    column.client += point.client
    column.total += point.server + point.client
  }

  const peak = Math.max(...buckets.map(column => column.total), 0)

  if (peak > 0) {
    for (const column of buckets) {
      column.height = column.total / peak
    }
  }

  return buckets
}

/**
 * `0.0342` → `3.4%`, and small non-zero rates never round to `0%`.
 *
 * `undefined` is "not measured", which is not the same as zero — an unknown
 * error rate must not read as a healthy one.
 */
export function formatRate(rate: number | undefined): string {
  return rate === undefined ? '—' : formatShare(rate)
}

/**
 * A 0–1 share as a percentage.
 *
 * Rounding a real failure rate down to zero would say "nothing is wrong", so
 * anything smaller than a tenth of a percent is spelled out instead. A decimal
 * is kept only when it says something: "6.0%" is noise next to "6%", but
 * "6.4%" is not.
 */
export function formatShare(share: number): string {
  const percent = share * 100

  if (percent > 0 && percent < 0.1) {
    return '<0.1%'
  }

  const rounded = percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent)

  return `${rounded}%`
}

/** Compact counts, so a busy number does not dominate the row it sits in. */
export function formatCount(value: number): string {
  if (value < 1_000) {
    return String(value)
  }

  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  }

  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * A CSS variable, resolved to a colour.
 *
 * ECharts paints on a canvas, where `var(--ui-warning)` is a string it cannot
 * resolve — it silently draws nothing, which reads as a broken chart rather
 * than as a styling slip. So the variables are read from the document and
 * passed as real colours, rather than the theme being duplicated in JavaScript
 * where it would quietly drift.
 */
export function cssColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim()

  return value || fallback
}

/** `var(--x)` from a caller, resolved; anything else passed through. */
export function resolveColor(color: string): string {
  const match = /^var\((--[^),]+)\)$/.exec(color.trim())

  return match ? cssColor(match[1]!, color) : color
}
