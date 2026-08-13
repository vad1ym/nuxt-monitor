import type { MonitorFrame } from '../../types'
import { describe, expect, it } from 'vitest'
import { culpritOf, culpritOfFrames } from './rows'

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

describe('culpritOf', () => {
  it('names the file and line from a raw stack', () => {
    expect(culpritOf('Error: x\n    at handler (/app/server/api/orders.ts:12:5)'))
      .toBe('api/orders.ts:12')
  })

  it('says nothing when the frame is the server bundle', () => {
    // In development every server route compiles into one file, so this frame
    // reads `dev/index.mjs:8484` — and so does the next issue's, and the
    // next. A location column where every server row names the same file is
    // not a weaker answer than the source, it is a confident wrong one: it
    // looks like somewhere to go and look, and it is the same somewhere for
    // every fault in the application.
    expect(culpritOf('Error: x\n    at handler (file:///app/.nuxt/dev/index.mjs:8484:13)'))
      .toBeUndefined()

    expect(culpritOf('Error: x\n    at handler (/app/.output/server/index.mjs:2201:9)'))
      .toBeUndefined()
  })

  it('still names a built chunk, which does identify a route', () => {
    // Unlike the single dev bundle, a per-route chunk is a real distinction —
    // and it is what the sourcemap corrects into a source path on open.
    expect(culpritOf('Error: x\n    at handler (/app/.output/server/chunks/routes/api/orders.mjs:15:3)'))
      .toBe('api/orders.mjs:15')
  })
})
