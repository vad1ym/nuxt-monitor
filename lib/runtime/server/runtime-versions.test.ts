import { describe, expect, it } from 'vitest'
import { describeRuntime } from './runtime-versions'

/**
 * The environment line.
 *
 * Decoration on an error, which is exactly why the cases worth testing are the
 * degraded ones: a missing version must shorten the line, never blank it or
 * leave a dangling separator, and it must never be the reason a capture fails.
 */

describe('the runtime line', () => {
  it('names everything it was given', () => {
    const line = describeRuntime({ nuxt: '4.5.2', nitro: '2.13.4' })

    expect(line).toContain('Nuxt 4.5.2')
    expect(line).toContain('Nitro 2.13.4')
  })

  it('always reports the Node actually executing', () => {
    // Not stamped at build time: a bundle built on one major and deployed onto
    // another is a real bug, and a build-time value would report the version
    // that did not run.
    expect(describeRuntime({})).toBe(`Node ${process.version.replace(/^v/, '')}`)
  })

  it('drops the leading v, which is noise beside a word', () => {
    expect(describeRuntime({})).not.toContain('Node v')
  })

  it('leaves out a version it does not have, without a dangling separator', () => {
    const line = describeRuntime({ nuxt: '4.5.2' })

    expect(line).toContain('Nuxt 4.5.2')
    expect(line).not.toContain('Nitro')
    expect(line?.endsWith('·')).toBe(false)
    expect(line).not.toContain('· ·')
  })

  it('survives being given nothing at all', () => {
    // The whole `versions` object is absent on a config written before this
    // existed — an upgrade must not start throwing inside the error hook.
    expect(() => describeRuntime(undefined)).not.toThrow()
    expect(describeRuntime(undefined)).toContain('Node')
  })
})
