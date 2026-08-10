import { describe, expect, it } from 'vitest'
import { formatCount, formatRate, toColumns } from './chart'

const HOUR = 60 * 60 * 1_000
const NOW = 1_700_000_000_000

describe('toColumns', () => {
  const options = { now: NOW, windowMs: HOUR, columns: 6 }

  it('always returns the requested number of columns', () => {
    expect(toColumns([], options)).toHaveLength(6)
  })

  it('renders silence as empty columns rather than skipping it', () => {
    // The API only returns buckets that had events. Plotting those directly
    // would compress an hour of quiet into nothing and hide the pattern.
    const columns = toColumns([{ bucket: NOW - HOUR / 2, server: 3, client: 0 }], options)

    expect(columns.filter(column => column.total === 0)).toHaveLength(5)
    expect(columns.filter(column => column.total > 0)).toHaveLength(1)
  })

  it('places a point in the column covering its time', () => {
    const columns = toColumns([{ bucket: NOW - HOUR + 1_000, server: 1, client: 0 }], options)

    expect(columns[0]!.total).toBe(1)
  })

  it('sums points that share a column', () => {
    const columns = toColumns([
      { bucket: NOW - HOUR + 1_000, server: 1, client: 0 },
      { bucket: NOW - HOUR + 2_000, server: 0, client: 2 },
    ], options)

    expect(columns[0]).toMatchObject({ server: 1, client: 2, total: 3 })
  })

  it('scales heights against the tallest column', () => {
    const columns = toColumns([
      { bucket: NOW - HOUR + 1_000, server: 10, client: 0 },
      { bucket: NOW - HOUR / 2, server: 5, client: 0 },
    ], options)

    expect(columns[0]!.height).toBe(1)
    expect(columns[3]!.height).toBeCloseTo(0.5)
  })

  it('leaves every height at zero when nothing happened', () => {
    expect(toColumns([], options).every(column => column.height === 0)).toBe(true)
  })

  it('drops points outside the window instead of piling them at the edge', () => {
    // Clamping would draw a spike at the boundary that never happened.
    const columns = toColumns([
      { bucket: NOW - 5 * HOUR, server: 100, client: 0 },
      { bucket: NOW + HOUR, server: 100, client: 0 },
    ], options)

    expect(columns.every(column => column.total === 0)).toBe(true)
  })

  it('labels each column with the time it starts', () => {
    const columns = toColumns([], options)

    expect(columns[0]!.at).toBe(NOW - HOUR)
    expect(columns[5]!.at).toBe(NOW - HOUR / 6)
  })
})

describe('formatRate', () => {
  it('shows a dash when there is no data', () => {
    // Not "0%" — that would claim nothing is failing.
    expect(formatRate(undefined)).toBe('—')
  })

  it('never rounds a real failure rate down to zero', () => {
    expect(formatRate(0.0002)).toBe('<0.1%')
    // A genuine zero is zero — the decimal would only add noise.
    expect(formatRate(0)).toBe('0%')
  })

  it('keeps a decimal for small rates and drops it for large ones', () => {
    expect(formatRate(0.034)).toBe('3.4%')
    expect(formatRate(0.5)).toBe('50%')
    expect(formatRate(1)).toBe('100%')
  })
})

describe('formatCount', () => {
  it('leaves small numbers alone', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
  })

  it('abbreviates larger ones', () => {
    expect(formatCount(1_500)).toBe('1.5k')
    expect(formatCount(42_000)).toBe('42k')
    expect(formatCount(2_400_000)).toBe('2.4M')
  })
})
