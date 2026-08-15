import { describe, expect, it } from 'vitest'
import { resolveOptionalAuth, resolveSourcemapBuilds } from './module'

/**
 * `auth.optional` serves the dashboard to anyone who can reach it.
 *
 * The whole safety of the option rests on this one function: it runs at build
 * time, so whatever it returns is baked into the artefact and no runtime value
 * — `NODE_ENV`, an env var, a proxy header — can change it afterwards. The
 * production cases below are the ones that matter; the dev cases only describe
 * the convenience.
 */
describe('resolveOptionalAuth', () => {
  it('is off in production however it was configured', () => {
    expect(resolveOptionalAuth(true, false)).toBe(false)
    expect(resolveOptionalAuth(false, false)).toBe(false)
    expect(resolveOptionalAuth(undefined, false)).toBe(false)
  })

  /**
   * The mistake this exists to survive: `optional: true` committed to
   * `nuxt.config.ts` during development and never taken out again.
   */
  it('ignores an explicit opt-in committed to the config', () => {
    expect(resolveOptionalAuth(true, false)).toBe(false)
  })

  it('is on by default in dev', () => {
    expect(resolveOptionalAuth(undefined, true)).toBe(true)
  })

  it('can be turned off in dev, to rehearse the real login', () => {
    expect(resolveOptionalAuth(false, true)).toBe(false)
  })

  it('is on when asked for in dev', () => {
    expect(resolveOptionalAuth(true, true)).toBe(true)
  })
})

/**
 * The rename of `keepSourcemapsFor`.
 *
 * A config key that quietly stops working is the worst kind of breaking
 * change: nothing fails at build time, and the consequence — a stack trace
 * that can no longer be resolved because the archive was trimmed to a size
 * nobody chose — surfaces weeks later during an incident.
 */
describe('resolveSourcemapBuilds', () => {
  it('keeps five builds by default', () => {
    expect(resolveSourcemapBuilds({})).toBe(5)
  })

  it('takes the new name', () => {
    expect(resolveSourcemapBuilds({ keepSourcemapBuilds: 2 })).toBe(2)
  })

  it('still honours the old one', () => {
    expect(resolveSourcemapBuilds({ keepSourcemapsFor: 9 })).toBe(9)
  })

  it('prefers the old name when both are set', () => {
    // The new key carries a default, so preferring it would silently ignore
    // the number actually written in the config file.
    expect(resolveSourcemapBuilds({ keepSourcemapsFor: 9, keepSourcemapBuilds: 5 })).toBe(9)
  })

  it('keeps an explicit zero rather than falling back', () => {
    // `0` means "keep none", and `??` is what makes that survive — `||` would
    // turn a deliberate opt-out back into the default of five.
    expect(resolveSourcemapBuilds({ keepSourcemapBuilds: 0 })).toBe(0)
    expect(resolveSourcemapBuilds({ keepSourcemapsFor: 0 })).toBe(0)
  })
})
