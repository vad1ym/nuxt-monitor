import { describe, expect, it } from 'vitest'

/**
 * Mirrors the per-request de-duplication in the Nitro collector.
 *
 * A render failure reaches the `error` hook twice: once via Nuxt's
 * `vue:error` bridge, and again when the error propagates out of the handler.
 * Nuxt wraps the original in an `H3Error` on the way, so the second arrival is
 * a different object *and* reports `name: 'Error'` instead of the real
 * constructor — which is why neither object identity nor the fingerprint
 * catches it. The stack head survives the wrapping intact.
 *
 * The logic is duplicated here rather than imported because the collector
 * module resolves `#imports`, which exists only inside a Nuxt build.
 */
function isDuplicate(error: { stack?: string }, event: { context: Record<string, unknown> } | undefined): boolean {
  const stack = error?.stack

  if (!event || !stack) {
    return false
  }

  const store = (event.context as { _monitorSeen?: Set<string> })._monitorSeen ??= new Set()
  const key = stack.split('\n').slice(0, 3).join('\n')

  if (store.has(key)) {
    return true
  }

  store.add(key)

  return false
}

function makeEvent(): { context: Record<string, unknown> } {
  return { context: {} }
}

const STACK = [
  'TypeError: Cannot read properties of null (reading \'theme\')',
  '    at setup (/app/pages/ssr-error.vue:20:56)',
  '    at _sfc_main.setup (/app/pages/ssr-error.vue:39:22)',
  '    at callWithErrorHandling (/node_modules/vue/index.js:1:1)',
].join('\n')

describe('per-request de-duplication', () => {
  it('reports a fault the first time it is seen', () => {
    expect(isDuplicate({ stack: STACK }, makeEvent())).toBe(false)
  })

  it('suppresses the wrapped second arrival of the same fault', () => {
    const event = makeEvent()

    // Nuxt's vue:error bridge reports the original TypeError.
    expect(isDuplicate({ stack: STACK }, event)).toBe(false)

    // The same fault propagates out of the handler as a *different* object,
    // rewrapped by h3 — same stack, and that is what identifies it.
    expect(isDuplicate({ stack: STACK }, event)).toBe(true)
  })

  it('keeps distinct faults in one request apart', () => {
    const event = makeEvent()
    const other = STACK.replace('ssr-error.vue:20:56', 'other.vue:7:3')

    expect(isDuplicate({ stack: STACK }, event)).toBe(false)
    expect(isDuplicate({ stack: other }, event)).toBe(false)
  })

  it('does not suppress the same fault across separate requests', () => {
    // Two visitors hitting one broken page must both be counted.
    expect(isDuplicate({ stack: STACK }, makeEvent())).toBe(false)
    expect(isDuplicate({ stack: STACK }, makeEvent())).toBe(false)
  })

  it('ignores frames below the head, which vary by call path', () => {
    const event = makeEvent()
    const deeper = `${STACK}\n    at renderComponentRoot (/node_modules/vue/index.js:9:9)`

    expect(isDuplicate({ stack: STACK }, event)).toBe(false)
    expect(isDuplicate({ stack: deeper }, event)).toBe(true)
  })

  it('never suppresses when there is no stack or no request', () => {
    const event = makeEvent()

    expect(isDuplicate({ stack: undefined }, event)).toBe(false)
    expect(isDuplicate({ stack: undefined }, event)).toBe(false)

    // Process-level errors arrive without an event and must all be recorded.
    expect(isDuplicate({ stack: STACK }, undefined)).toBe(false)
    expect(isDuplicate({ stack: STACK }, undefined)).toBe(false)
  })
})
