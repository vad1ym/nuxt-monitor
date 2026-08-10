import { describe, expect, it } from 'vitest'
import { resolveOptionalAuth } from './module'

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
