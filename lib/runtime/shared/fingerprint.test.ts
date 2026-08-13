import { describe, expect, it } from 'vitest'
import { fingerprint, normalizeMessage, topFrame } from './fingerprint'

const base = { side: 'server' as const, type: 'TypeError' }

describe('normalizeMessage', () => {
  it('strips ids that vary per occurrence', () => {
    const a = normalizeMessage('User 12345 not found')
    const b = normalizeMessage('User 67890 not found')

    expect(a).toBe(b)
  })

  it('strips uuids', () => {
    const a = normalizeMessage('Order 550e8400-e29b-41d4-a716-446655440000 failed')
    const b = normalizeMessage('Order 6ba7b810-9dad-11d1-80b4-00c04fd430c8 failed')

    expect(a).toBe(b)
  })

  it('strips quoted payloads', () => {
    // What is quoted here is data from the request: two customers, one fault.
    expect(normalizeMessage(`User 'ada@example.com' not found`))
      .toBe(normalizeMessage(`User 'bob@other.org' not found`))
  })

  it('keeps a quoted identifier, because it names the fault', () => {
    // `reading 'width'` and `reading 'remaining'` are two different bugs. This
    // was found in the example app: in development every handler compiles into
    // one bundle, so the top frame is identical too — and with the property
    // name stripped as well, two unrelated faults shared a single issue.
    expect(normalizeMessage(`Cannot read properties of undefined (reading 'width')`))
      .not.toBe(normalizeMessage(`Cannot read properties of undefined (reading 'remaining')`))
  })

  it('keeps genuinely different messages apart', () => {
    expect(normalizeMessage('Connection refused')).not.toBe(normalizeMessage('Timeout exceeded'))
  })

  it('collapses whitespace so wrapping does not matter', () => {
    expect(normalizeMessage('a   b\n  c')).toBe('a b c')
  })
})

describe('topFrame', () => {
  it('skips node_modules and framework frames', () => {
    const stack = [
      'TypeError: boom',
      '    at renderComponent (/app/node_modules/vue/dist/runtime.js:100:5)',
      '    at setup (/app/pages/index.vue:12:3)',
    ].join('\n')

    expect(topFrame(stack)).toContain('/app/pages/index.vue')
  })

  it('drops line and column so a shifted file does not fork the issue', () => {
    const one = topFrame('Error: x\n    at fn (/app/a.ts:10:5)')
    const two = topFrame('Error: x\n    at fn (/app/a.ts:42:9)')

    expect(one).toBe(two)
  })

  it('falls back to the first frame when everything is vendor code', () => {
    const stack = 'Error: x\n    at q (/app/node_modules/lib/index.js:1:1)'

    expect(topFrame(stack)).toContain('node_modules/lib/index.js')
  })

  it('returns empty string without a stack', () => {
    expect(topFrame(undefined)).toBe('')
  })
})

describe('fingerprint', () => {
  it('groups the same fault seen twice', () => {
    const stack = 'TypeError: boom\n    at setup (/app/pages/index.vue:12:3)'

    expect(fingerprint({ ...base, message: 'User 1 missing', stack }))
      .toBe(fingerprint({ ...base, message: 'User 2 missing', stack }))
  })

  it('separates different call sites', () => {
    const a = fingerprint({ ...base, message: 'boom', stack: 'E\n    at a (/app/a.ts:1:1)' })
    const b = fingerprint({ ...base, message: 'boom', stack: 'E\n    at b (/app/b.ts:1:1)' })

    expect(a).not.toBe(b)
  })

  it('separates client from server for an otherwise identical error', () => {
    const event = { type: 'Error', message: 'boom', stack: 'E\n    at a (/app/a.ts:1:1)' }

    expect(fingerprint({ ...event, side: 'client' }))
      .not.toBe(fingerprint({ ...event, side: 'server' }))
  })

  it('groups the same fault across deploys', () => {
    // Server frames carry the absolute path of the Nitro output and a chunk
    // hash, both of which change on every build. Without normalising them a
    // release would fork every open issue and reset its history.
    const before = fingerprint({
      ...base,
      message: 'boom',
      stack: 'TypeError: boom\n    at setup (file:///srv/app/.output/server/chunks/build/page-C2V2OSOE.mjs:30:27)',
    })

    const after = fingerprint({
      ...base,
      message: 'boom',
      stack: 'TypeError: boom\n    at setup (file:///opt/release-42/.output/server/chunks/build/page-6A6825Cy.mjs:31:29)',
    })

    expect(before).toBe(after)
  })

  it('still separates faults in different chunks', () => {
    const one = fingerprint({
      ...base,
      message: 'boom',
      stack: 'E: boom\n    at s (file:///srv/.output/server/chunks/build/alpha-AAAAAAAA.mjs:1:1)',
    })

    const two = fingerprint({
      ...base,
      message: 'boom',
      stack: 'E: boom\n    at s (file:///srv/.output/server/chunks/build/beta-AAAAAAAA.mjs:1:1)',
    })

    expect(one).not.toBe(two)
  })

  it('separates different error types', () => {
    const rest = { side: 'server' as const, message: 'boom', stack: 'E\n    at a (/app/a.ts:1:1)' }

    expect(fingerprint({ ...rest, type: 'TypeError' }))
      .not.toBe(fingerprint({ ...rest, type: 'RangeError' }))
  })
})

describe('groups', () => {
  const base = {
    side: 'server' as const,
    type: 'MonitorException',
    message: 'totals disagree',
    stack: 'E\n    at check (/app/billing.ts:9:1)',
  }

  it('separates the same report raised under two groups', () => {
    expect(fingerprint({ ...base, group: 'payments' }))
      .not.toBe(fingerprint({ ...base, group: 'data-integrity' }))
  })

  it('leaves an ungrouped fingerprint exactly as it was', () => {
    // The value is pinned, not merely compared against itself: adding a part to
    // the hash for events that carry no group would change every fingerprint
    // already in the table, and an upgrade would split each open issue into a
    // new one beside the old — work in progress would look freshly discovered.
    expect(fingerprint(base)).toBe('15d0869ba78f60a7')
    expect(fingerprint({ ...base, group: undefined })).toBe(fingerprint(base))
  })
})
