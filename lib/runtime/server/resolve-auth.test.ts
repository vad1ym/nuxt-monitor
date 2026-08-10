import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, verifySession, createSession } from './auth'
import { resolveAuth } from './session'

/**
 * `runtimeConfig` is JSON, and Nuxt serializes unset string options as `''`
 * rather than dropping them. Treating those empty strings as present is how
 * the dashboard ends up returning 404 with a password correctly configured, so
 * every field is checked against that shape.
 */
describe('resolveAuth', () => {
  it('hashes a plaintext password', () => {
    const auth = resolveAuth({ username: 'admin', password: 'hunter2' })

    expect(auth).toBeDefined()
    expect(auth!.passwordHash).not.toContain('hunter2')
    expect(verifyPassword('hunter2', auth!.passwordHash)).toBe(true)
  })

  it('accepts a precomputed hash', () => {
    const hash = hashPassword('hunter2')
    const auth = resolveAuth({ passwordHash: hash })

    expect(auth!.passwordHash).toBe(hash)
  })

  it('ignores an empty passwordHash and falls back to the password', () => {
    const auth = resolveAuth({ passwordHash: '', password: 'hunter2' })

    expect(auth).toBeDefined()
    expect(verifyPassword('hunter2', auth!.passwordHash)).toBe(true)
  })

  it('ignores an empty secret and derives one instead', () => {
    const auth = resolveAuth({ password: 'hunter2', secret: '' })

    expect(auth!.secret).not.toBe('')
    // A usable secret round-trips a session.
    expect(verifySession(createSession(auth!), auth!)).toBe(true)
  })

  it('ignores an empty username and falls back to the default', () => {
    expect(resolveAuth({ username: '', password: 'x' })!.username).toBe('admin')
  })

  it('ignores a zero ttl and falls back to the default', () => {
    expect(resolveAuth({ password: 'x', sessionTtl: 0 })!.ttl).toBe(60 * 60 * 24 * 7)
  })

  it('honours an explicit secret and ttl', () => {
    const auth = resolveAuth({ password: 'x', secret: 'mine', sessionTtl: 60 })

    expect(auth!.secret).toBe('mine')
    expect(auth!.ttl).toBe(60)
  })

  it('returns undefined without any credential', () => {
    expect(resolveAuth({})).toBeUndefined()
    expect(resolveAuth({ username: 'admin' })).toBeUndefined()
    // The exact shape runtimeConfig produces when nothing is configured.
    expect(resolveAuth({ username: 'admin', password: '', passwordHash: '', secret: '' })).toBeUndefined()
  })
})

/**
 * The session secret has to survive a restart.
 *
 * It used to be derived from the `scrypt` hash of the password, which is
 * salted randomly — so every boot produced a different secret, every restart
 * logged everybody out, and no two instances behind a load balancer could read
 * each other's cookies.
 */
describe('session secret stability', () => {
  it('is the same across restarts for a plaintext password', () => {
    const first = resolveAuth({ password: 'hunter2' })
    const second = resolveAuth({ password: 'hunter2' })

    expect(first?.secret).toBe(second?.secret)
    // The hashes still differ — that is the salt doing its job.
    expect(first?.passwordHash).not.toBe(second?.passwordHash)
  })

  it('changes when the password changes, so a change logs everyone out', () => {
    expect(resolveAuth({ password: 'hunter2' })?.secret)
      .not.toBe(resolveAuth({ password: 'hunter3' })?.secret)
  })

  it('is stable for a configured hash too', () => {
    const hash = resolveAuth({ password: 'hunter2' })!.passwordHash

    expect(resolveAuth({ passwordHash: hash })?.secret)
      .toBe(resolveAuth({ passwordHash: hash })?.secret)
  })

  it('prefers an explicit secret over anything derived', () => {
    expect(resolveAuth({ password: 'hunter2', secret: 'chosen' })?.secret).toBe('chosen')
  })
})
