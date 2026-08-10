import { describe, expect, it } from 'vitest'
import { REDACTED, scrub, scrubUrl } from './scrub'

describe('scrub', () => {
  it('redacts request headers that carry credentials', () => {
    const out = scrub({
      authorization: 'Bearer abc123',
      cookie: 'session=xyz',
      'content-type': 'application/json',
    })

    expect(out.authorization).toBe(REDACTED)
    expect(out.cookie).toBe(REDACTED)
    expect(out['content-type']).toBe('application/json')
  })

  it('matches on substrings, whatever the spelling', () => {
    const out = scrub({
      userPassword: 'hunter2',
      refresh_token: 'r',
      'X-Auth-Token': 't',
      APIKey: 'k',
      username: 'ok',
    })

    expect(out.userPassword).toBe(REDACTED)
    expect(out.refresh_token).toBe(REDACTED)
    expect(out['X-Auth-Token']).toBe(REDACTED)
    expect(out.APIKey).toBe(REDACTED)
    // Not a credential — redacting it would lose useful context.
    expect(out.username).toBe('ok')
  })

  it('reaches nested objects and arrays', () => {
    const out = scrub({
      req: { headers: { cookie: 'a' } },
      users: [{ password: 'p', name: 'n' }],
    }) as any

    expect(out.req.headers.cookie).toBe(REDACTED)
    expect(out.users[0].password).toBe(REDACTED)
    expect(out.users[0].name).toBe('n')
  })

  it('accepts extra keys from config', () => {
    const out = scrub({ ssn: '123' }, { extraKeys: ['ssn'] })

    expect(out.ssn).toBe(REDACTED)
  })

  it('survives cycles', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node.self = node

    expect(() => scrub(node)).not.toThrow()
    expect((scrub(node) as any).self).toBe('[circular]')
  })

  it('bounds depth, array length and string size', () => {
    let deep: Record<string, unknown> = { end: true }
    for (let i = 0; i < 20; i++) {
      deep = { next: deep }
    }
    expect(JSON.stringify(scrub(deep))).toContain('[depth limit]')

    const long = scrub({ items: Array.from({ length: 500 }, (_, i) => i) }) as any
    expect(long.items).toHaveLength(101)
    expect(long.items.at(-1)).toContain('400 more')

    const big = scrub({ text: 'x'.repeat(20_000) }) as any
    expect(big.text).toContain('[truncated]')
  })

  it('leaves primitives alone', () => {
    expect(scrub(42)).toBe(42)
    expect(scrub(null)).toBe(null)
  })
})

describe('scrubUrl', () => {
  it('redacts sensitive query parameters', () => {
    expect(scrubUrl('/callback?token=secret&page=2'))
      .toBe(`/callback?token=${encodeURIComponent(REDACTED)}&page=2`)
  })

  it('strips basic-auth credentials', () => {
    expect(scrubUrl('https://user:pw@example.com/x')).not.toContain('pw')
  })

  it('keeps relative paths relative', () => {
    expect(scrubUrl('/a/b?c=1')).toBe('/a/b?c=1')
  })

  it('treats unrecognised input as a relative path rather than dropping it', () => {
    // Resolving against a base means nearly anything parses as a path, which
    // is the safe outcome: it still goes through parameter scrubbing.
    expect(scrubUrl('ht!tp://[')).toBe('/ht!tp://[')
  })

  it('still scrubs parameters on malformed-looking input', () => {
    const out = scrubUrl('not a url?access_token=leak')

    // The replacement is percent-encoded by the URL serializer; what matters
    // is that the secret is gone.
    expect(decodeURIComponent(out)).toContain(REDACTED)
    expect(out).not.toContain('leak')
  })
})
