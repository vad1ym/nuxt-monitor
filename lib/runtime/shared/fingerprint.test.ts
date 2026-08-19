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

  it('keeps a quoted path, because it names the endpoint that failed', () => {
    // `$fetch` reports failures as `[GET] "/api/thing": 404`, and collapsing
    // the path to `<str>` left `[GET] <str>: <n>` — a key every 404 in the
    // application shares. A missing health page and a missing root page then
    // sat in one issue, its title taken from one occurrence and the request
    // badge beside it from another, reading as cause and effect.
    expect(normalizeMessage('[GET] "/api/health-pages/x": 404'))
      .not.toBe(normalizeMessage('[GET] "/activate": 404'))
  })

  it('collapses content slugs, so one fault is one issue', () => {
    // A thousand missing health pages are one fault, not a thousand.
    expect(normalizeMessage('[GET] "/api/health-pages/bol-v-molochnye-zhelezy": 404'))
      .toBe(normalizeMessage('[GET] "/api/health-pages/vidkashliuvannia-krovi-krov-u-mokrotinni": 404'))
  })

  it('keeps a short static tail segment', () => {
    // `reset-password` is route structure; collapsing it would merge every
    // endpoint under `/api/user`.
    expect(normalizeMessage('[GET] "/api/user/reset-password": 500'))
      .not.toBe(normalizeMessage('[GET] "/api/user/change-email": 500'))
  })

  it('drops the query string, which is per-request detail', () => {
    expect(normalizeMessage('[GET] "/api/promo-code-check?code=TEST20": 404'))
      .toBe(normalizeMessage('[GET] "/api/promo-code-check?code=SUMMER": 404'))
  })

  it('keeps the quote character the message used', () => {
    // Re-quoting `'/a'` as `"/a"` would fingerprint two spellings apart.
    expect(normalizeMessage(`[GET] '/api/orders': 500`)).toContain(`'/api/orders'`)
  })

  it('still collapses a sentence that merely mentions a slash', () => {
    expect(normalizeMessage('Failed at "some/path is broken here"'))
      .toBe(normalizeMessage('Failed at "another/thing went wrong"'))
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
