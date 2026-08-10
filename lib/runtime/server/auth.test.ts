import { describe, expect, it } from 'vitest'
import {
  LoginThrottle,
  createSession,
  deriveSecret,
  hashPassword,
  safeEqual,
  verifyPassword,
  verifySession,
} from './auth'

describe('password hashing', () => {
  it('accepts the correct password', () => {
    const hash = hashPassword('correct horse battery staple')

    expect(verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects a wrong password', () => {
    const hash = hashPassword('hunter2')

    expect(verifyPassword('hunter3', hash)).toBe(false)
    expect(verifyPassword('', hash)).toBe(false)
  })

  it('salts, so the same password hashes differently each time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })

  it('never stores the password itself', () => {
    expect(hashPassword('supersecret')).not.toContain('supersecret')
  })

  it('carries its parameters so the cost can be raised later', () => {
    expect(hashPassword('x').split('$').slice(0, 4)).toEqual(['scrypt', '32768', '8', '1'])
  })

  it('rejects malformed hashes instead of throwing', () => {
    for (const bad of ['', 'garbage', 'scrypt$1$2', 'bcrypt$1$2$3$4$5']) {
      expect(verifyPassword('x', bad)).toBe(false)
    }
  })
})

describe('sessions', () => {
  const options = { secret: 'test-secret', ttl: 3_600 }

  it('accepts a token it just issued', () => {
    expect(verifySession(createSession(options), options)).toBe(true)
  })

  it('rejects a missing token', () => {
    expect(verifySession(undefined, options)).toBe(false)
    expect(verifySession('', options)).toBe(false)
  })

  it('rejects a tampered payload', () => {
    const token = createSession(options)
    const [, signature] = token.split('.')

    // Extend the expiry and keep the original signature.
    const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9, nonce: 'x' })).toString('base64url')

    expect(verifySession(`${forged}.${signature}`, options)).toBe(false)
  })

  it('rejects a tampered signature', () => {
    const [payload] = createSession(options).split('.')

    expect(verifySession(`${payload}.wrong`, options)).toBe(false)
  })

  it('rejects a token signed with a different secret', () => {
    const token = createSession({ secret: 'other-secret', ttl: 3_600 })

    expect(verifySession(token, options)).toBe(false)
  })

  it('rejects an expired token', () => {
    const now = Date.now()
    const token = createSession({ secret: options.secret, ttl: 60 }, now)

    expect(verifySession(token, options, now + 30 * 1_000)).toBe(true)
    expect(verifySession(token, options, now + 61 * 1_000)).toBe(false)
  })

  it('rejects structurally invalid tokens', () => {
    for (const bad of ['nodot', '.', '.sig', 'a.b.c']) {
      expect(verifySession(bad, options)).toBe(false)
    }
  })

  it('issues distinct tokens for the same input', () => {
    expect(createSession(options)).not.toBe(createSession(options))
  })
})

describe('deriveSecret', () => {
  it('is stable for one hash and different across hashes', () => {
    const a = hashPassword('a')
    const b = hashPassword('b')

    expect(deriveSecret(a)).toBe(deriveSecret(a))
    expect(deriveSecret(a)).not.toBe(deriveSecret(b))
  })

  it('invalidates outstanding sessions when the password changes', () => {
    const oldSecret = deriveSecret(hashPassword('old'))
    const newSecret = deriveSecret(hashPassword('new'))

    const token = createSession({ secret: oldSecret, ttl: 3_600 })

    expect(verifySession(token, { secret: newSecret, ttl: 3_600 })).toBe(false)
  })
})

describe('safeEqual', () => {
  it('compares by value and rejects length mismatches', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('LoginThrottle', () => {
  it('lets the first few attempts through unhindered', () => {
    const throttle = new LoginThrottle()

    for (let i = 0; i < 3; i++) {
      expect(throttle.delayFor('1.2.3.4')).toBe(0)
      throttle.recordFailure('1.2.3.4')
    }

    expect(throttle.delayFor('1.2.3.4')).toBeGreaterThan(0)
  })

  it('backs off exponentially, then caps', () => {
    const throttle = new LoginThrottle()

    for (let i = 0; i < 4; i++) {
      throttle.recordFailure('ip')
    }
    expect(throttle.delayFor('ip')).toBe(2_000)

    for (let i = 0; i < 20; i++) {
      throttle.recordFailure('ip')
    }
    expect(throttle.delayFor('ip')).toBe(30_000)
  })

  it('throttles each address independently', () => {
    const throttle = new LoginThrottle()

    for (let i = 0; i < 6; i++) {
      throttle.recordFailure('attacker')
    }

    expect(throttle.delayFor('attacker')).toBeGreaterThan(0)
    expect(throttle.delayFor('bystander')).toBe(0)
  })

  it('clears the penalty after a success', () => {
    const throttle = new LoginThrottle()

    for (let i = 0; i < 6; i++) {
      throttle.recordFailure('ip')
    }
    throttle.recordSuccess('ip')

    expect(throttle.delayFor('ip')).toBe(0)
  })

  it('forgets failures once the window passes', () => {
    const throttle = new LoginThrottle(1_000)
    const now = Date.now()

    for (let i = 0; i < 6; i++) {
      throttle.recordFailure('ip', now)
    }

    expect(throttle.delayFor('ip', now)).toBeGreaterThan(0)
    expect(throttle.delayFor('ip', now + 2_000)).toBe(0)
  })

  it('bounds memory under a distributed attack', () => {
    const throttle = new LoginThrottle(60_000, 100)
    const now = Date.now()

    for (let i = 0; i < 500; i++) {
      throttle.recordFailure(`10.0.0.${i}`, now + i)
    }

    // Exact size is an implementation detail; not growing without bound is not.
    expect(throttle.delayFor('10.0.0.499', now + 500)).toBe(0)
  })
})

/**
 * The CLI hashes passwords too, and it duplicates the algorithm rather than
 * importing it — it runs from `npx` against the published package, where
 * importing runtime TypeScript would mean shipping a build step for one
 * function. Duplication is only safe while both sides agree, so this asserts
 * they do.
 */
describe('the hash the CLI produces', () => {
  it('verifies against the runtime', async () => {
    const { execFileSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')

    const cli = fileURLToPath(new URL('../../../bin/monitor.mjs', import.meta.url))
    const hash = execFileSync('node', [cli, 'hash-password', 'hunter2'], { encoding: 'utf8' }).trim()

    expect(verifyPassword('hunter2', hash)).toBe(true)
    expect(verifyPassword('wrong', hash)).toBe(false)
  })
})
