import type { MonitorFrame } from '../../types'
import { describe, expect, it } from 'vitest'
import { culpritOfFrames } from './rows'

/**
 * Naming a fault from frames a sourcemap has already resolved.
 *
 * The counterpart, `culpritOf`, reads the built file and is covered through
 * the store — see `store.test.ts`. This one is about what the reader should
 * see once the maps have been consulted: the file they can actually open.
 */

function frame(file: string, original?: { file: string, line: number }): MonitorFrame {
  return {
    file,
    line: 1,
    column: 1,
    original: original ? { ...original, column: 1 } : undefined,
  }
}

describe('culpritOfFrames', () => {
  it('names the original source rather than the built file', () => {
    // The path as a real map writes it: relative to the map, which sits deep
    // inside `.output`, so it climbs back out first. Taken from the example
    // build's `chunks/routes/api/throw.mjs.map`.
    const frames = [frame('/app/.output/server/chunks/routes/api/throw.mjs', {
      file: '../../../../../server/api/throw.ts',
      line: 5,
    })]

    // The whole point: `api/throw.mjs:15` is a file nobody wrote and nobody
    // can open.
    expect(culpritOfFrames(frames)).toBe('server/api/throw.ts:5')
  })

  it('keeps the directory that says which part of the app this is', () => {
    // `app/pages/…` and `server/api/…` both end in two segments that look
    // alike; the segment in front is the one that tells them apart.
    expect(culpritOfFrames([frame('/a.mjs', { file: '../../../../app/pages/ssr-error.vue', line: 4 })]))
      .toBe('app/pages/ssr-error.vue:4')
  })

  it('skips library frames', () => {
    const frames = [
      frame('/app/chunk.mjs', { file: '../node_modules/vue/dist/runtime.js', line: 100 }),
      frame('/app/chunk.mjs', { file: '../app/pages/index.vue', line: 12 }),
    ]

    expect(culpritOfFrames(frames)).toBe('app/pages/index.vue:12')
  })

  it('skips frames no map covered', () => {
    const frames = [
      frame('/app/.output/server/chunks/nitro.mjs'),
      frame('/app/chunk.mjs', { file: '../../server/api/orders.ts', line: 42 }),
    ]

    // An unresolved frame carries only the built path, which is the name this
    // function exists to replace — using it would overwrite a good value with
    // the guess it is meant to correct.
    expect(culpritOfFrames(frames)).toBe('server/api/orders.ts:42')
  })

  it('strips the prefixes bundlers put in front of sources', () => {
    expect(culpritOfFrames([frame('/a.mjs', { file: './pages/index.vue', line: 3 })]))
      .toBe('pages/index.vue:3')

    expect(culpritOfFrames([frame('/a.mjs', { file: 'webpack://app/src/main.ts', line: 7 })]))
      .toBe('src/main.ts:7')
  })

  it('has nothing to say when no frame resolved', () => {
    expect(culpritOfFrames([frame('/app/.output/server/chunks/nitro.mjs')])).toBeUndefined()
    expect(culpritOfFrames([])).toBeUndefined()
  })
})
