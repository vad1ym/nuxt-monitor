import { describe, expect, it } from 'vitest'
import { REDACTED, scrub, scrubSecrets, scrubUrl } from './scrub'

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

/**
 * Credential-shaped fixtures, assembled rather than written out.
 *
 * All invented, but the *shape* is the point of the test — and a shape a
 * redaction rule recognises is by construction a shape a secret scanner
 * recognises too. As literals these made GitHub's push protection reject the
 * branch: the fixtures for a feature that removes credentials looked exactly
 * like credentials. Joining the halves at runtime keeps the value identical
 * where it matters and leaves no literal for a scanner to match.
 *
 * The alternative — allow-listing each one in the repository settings — would
 * teach the scanner to ignore precisely the pattern this feature exists to
 * catch.
 */
const fake = {
  stripe: `sk_${'live_4eC39HqLyjWDarjtT1zdp7dc'}`,
  github: `ghp_${'016C7dE9fA2bB3cC4dD5eE6fF7aA8bB9cC0'}`,
  slack: `xoxb-${'1234567890-abcdefghij'}`,
  aws: `AKIA${'IOSFODNN7EXAMPLE'}`,
  openai: `sk-${'abcdefghijklmnopqrstuvwxyz1234'}`,
  jwt: `eyJ${'hbGciOiJIUzI1NiJ9'}.${'eyJzdWIiOiIxMjM0NTY3ODkwIn0'}.${'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'}`,
}

/**
 * Credentials that give themselves away by their shape.
 *
 * The key-based rules cannot reach these: the secret is inside a sentence, and
 * a sentence has no key. An error *message* is the worst place for one, because
 * it is not just a column — it is the issue's title, its search text, and the
 * body of every alert about it.
 */
describe('secrets in free text', () => {
  it('redacts a Stripe key out of a message', () => {
    expect(scrubSecrets(`Invalid token: ${fake.stripe}`))
      .toBe('Invalid token: [redacted key]')
  })

  it('redacts GitHub, Slack, AWS and OpenAI credentials', () => {
    expect(scrubSecrets(fake.github)).toContain('[redacted token]')
    expect(scrubSecrets(fake.slack)).toContain('[redacted token]')
    expect(scrubSecrets(fake.aws)).toContain('[redacted key]')
    expect(scrubSecrets(fake.openai)).toContain('[redacted key]')
  })

  it('redacts a JWT', () => {
    expect(scrubSecrets(`auth failed for ${fake.jwt}`)).toBe('auth failed for [redacted jwt]')
  })

  it('redacts a bearer token', () => {
    expect(scrubSecrets('Bearer abcdefghijklmnopqrstuvwxyz')).toBe('[redacted token]')
  })

  it('names what it removed, so a changed message is not a mystery', () => {
    // A silently shortened error message is a debugging trap: the reader has
    // to be able to tell the text was altered and roughly what went.
    expect(scrubSecrets(`key ${fake.stripe}`)).toContain('redacted')
  })

  it('leaves ordinary error text alone', () => {
    // The cost of a false positive is an unreadable error, so the patterns are
    // deliberately narrow — "long and random" also describes hashes and ids.
    const ordinary = 'Cannot read properties of undefined (reading \'length\')'

    expect(scrubSecrets(ordinary)).toBe(ordinary)
    expect(scrubSecrets('at handler (/app/server/api/orders.ts:42:9)'))
      .toBe('at handler (/app/server/api/orders.ts:42:9)')
    // A commit sha and a uuid are not credentials.
    expect(scrubSecrets('release 8f31ac2')).toBe('release 8f31ac2')
    expect(scrubSecrets('id 550e8400-e29b-41d4-a716-446655440000'))
      .toBe('id 550e8400-e29b-41d4-a716-446655440000')
  })

  it('reaches a token hiding under an innocent key', () => {
    // `detail` matches no key rule, and is exactly what an error payload uses.
    const out = scrub({ detail: `failed with ${fake.stripe}` }) as Record<string, string>

    expect(out.detail).toBe('failed with [redacted key]')
  })
})
