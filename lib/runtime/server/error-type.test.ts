import { describe, expect, it } from 'vitest'

/**
 * Mirrors `errorType` in the Nitro collector.
 *
 * h3 rewraps thrown errors in an `H3Error` before the collector sees them, so
 * `error.name` reports `Error` even when a `TypeError` was thrown. The first
 * stack line keeps the original name. Duplicated here rather than imported
 * because the collector resolves `#imports`, which exists only inside a Nuxt
 * build.
 */
function errorType(error: { name?: string, stack?: string }): string {
  const name = error?.name

  if (name && name !== 'Error' && name !== 'H3Error') {
    return name
  }

  const header = error?.stack?.split('\n')[0] ?? ''
  const match = /^([A-Za-z_$][\w$]*(?:Error|Exception))\s*:/.exec(header.trim())

  return match?.[1] ?? name ?? 'Error'
}

describe('errorType', () => {
  it('trusts a specific name when one survived', () => {
    expect(errorType({ name: 'TypeError', stack: 'TypeError: x\n at y' })).toBe('TypeError')
    expect(errorType({ name: 'RangeError' })).toBe('RangeError')
  })

  it('recovers the real name from the stack after h3 rewrapping', () => {
    expect(errorType({
      name: 'Error',
      stack: 'TypeError: Cannot read properties of undefined (reading \'url\')\n    at handler (/app/api.ts:3:9)',
    })).toBe('TypeError')

    expect(errorType({
      name: 'H3Error',
      stack: 'ReferenceError: thing is not defined\n    at fn (/app/x.ts:1:1)',
    })).toBe('ReferenceError')
  })

  it('keeps custom error classes', () => {
    expect(errorType({
      name: 'Error',
      stack: 'ValidationError: field missing\n    at check (/app/v.ts:2:2)',
    })).toBe('ValidationError')
  })

  it('falls back to Error when the stack carries no name', () => {
    expect(errorType({ name: 'Error', stack: 'something went wrong\n    at fn (/a.ts:1:1)' })).toBe('Error')
    expect(errorType({ name: 'Error' })).toBe('Error')
    expect(errorType({})).toBe('Error')
  })

  it('does not mistake a message containing a colon for a type', () => {
    expect(errorType({
      name: 'Error',
      stack: 'Error: connection to db:5432 refused\n    at connect (/app/db.ts:1:1)',
    })).toBe('Error')
  })

  it('ignores a lowercase or non-error-shaped prefix', () => {
    expect(errorType({ name: 'Error', stack: 'warning: deprecated\n at x' })).toBe('Error')
  })
})
