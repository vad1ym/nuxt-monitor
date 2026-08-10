import { describe, expect, it } from 'vitest'
import type { MonitorEvent } from '../../types'
import { compileIgnore, shouldIgnore } from './ignore'

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    side: 'server',
    type: 'Error',
    message: 'something broke',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('default rules', () => {
  const rules = compileIgnore(undefined)

  it('drops 4xx, which are client mistakes rather than application faults', () => {
    expect(shouldIgnore(makeEvent({ context: { statusCode: 404 } }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ context: { statusCode: 401 } }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ context: { statusCode: 422 } }), rules)).toBe(true)
  })

  it('keeps 5xx, which are the application failing', () => {
    expect(shouldIgnore(makeEvent({ context: { statusCode: 500 } }), rules)).toBe(false)
    expect(shouldIgnore(makeEvent({ context: { statusCode: 503 } }), rules)).toBe(false)
  })

  it('keeps errors that carry no status at all', () => {
    expect(shouldIgnore(makeEvent(), rules)).toBe(false)
    expect(shouldIgnore(makeEvent({ context: { url: '/x' } }), rules)).toBe(false)
  })
})

describe('configured rules', () => {
  it('records 4xx when the list is emptied', () => {
    const rules = compileIgnore({ statuses: [] })

    expect(shouldIgnore(makeEvent({ context: { statusCode: 404 } }), rules)).toBe(false)
  })

  it('matches messages as case-insensitive substrings', () => {
    const rules = compileIgnore({ messages: ['ResizeObserver'] })

    expect(shouldIgnore(makeEvent({ message: 'ResizeObserver loop limit exceeded' }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ message: 'resizeobserver loop' }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ message: 'a real failure' }), rules)).toBe(false)
  })

  it('accepts regular expressions', () => {
    const rules = compileIgnore({ messages: ['/^Script error\\.?$/i'] })

    expect(shouldIgnore(makeEvent({ message: 'Script error.' }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ message: 'Script error in checkout' }), rules)).toBe(false)
  })

  it('matches routes', () => {
    const rules = compileIgnore({ routes: ['/health', '/^\\/metrics/'] })

    expect(shouldIgnore(makeEvent({ context: { url: '/health' } }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ context: { url: '/metrics/cpu' } }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ context: { url: '/api/orders' } }), rules)).toBe(false)
  })

  it('matches error types exactly', () => {
    const rules = compileIgnore({ types: ['AbortError'] })

    expect(shouldIgnore(makeEvent({ type: 'AbortError' }), rules)).toBe(true)
    // Exact, not substring: `AbortErrorHandler` is a different thing.
    expect(shouldIgnore(makeEvent({ type: 'AbortErrorHandler' }), rules)).toBe(false)
  })

  it('drops an event matching any single rule', () => {
    const rules = compileIgnore({ messages: ['noise'], routes: ['/health'], types: ['AbortError'] })

    expect(shouldIgnore(makeEvent({ message: 'some noise here' }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ context: { url: '/health' } }), rules)).toBe(true)
    expect(shouldIgnore(makeEvent({ type: 'AbortError' }), rules)).toBe(true)
  })

  it('treats a malformed pattern as a literal rather than failing', () => {
    const rules = compileIgnore({ messages: ['/[unclosed/'] })

    expect(() => shouldIgnore(makeEvent(), rules)).not.toThrow()
    expect(shouldIgnore(makeEvent({ message: 'contains [unclosed here' }), rules)).toBe(true)
  })

  it('does not let a global flag make matching stateful', () => {
    const rules = compileIgnore({ messages: ['/boom/g'] })
    const event = makeEvent({ message: 'boom' })

    // With `g` retained, `lastIndex` would carry over and the second call
    // would disagree with the first.
    expect(shouldIgnore(event, rules)).toBe(true)
    expect(shouldIgnore(event, rules)).toBe(true)
  })
})
