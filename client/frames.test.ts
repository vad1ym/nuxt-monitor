import { describe, expect, it } from 'vitest'
import type { MonitorFrame } from '../lib/types'
import { groupFrames, isVendorFrame, primaryFrame, shortLocation, shortPath } from './frames'

function frame(file: string, line = 1, original?: string): MonitorFrame {
  return {
    file,
    line,
    column: 1,
    ...(original ? { original: { file: original, line, column: 1 } } : {}),
  }
}

const APP = '/app/pages/index.vue'
const VUE = '/app/node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js'
const REACTIVITY = '/app/node_modules/@vue/reactivity/dist/reactivity.esm-bundler.js'

describe('isVendorFrame', () => {
  it('recognises dependencies and node internals', () => {
    expect(isVendorFrame(frame(VUE))).toBe(true)
    expect(isVendorFrame(frame('node:internal/process/task_queues'))).toBe(true)
    expect(isVendorFrame(frame('/srv/.output/server/chunks/build/x.mjs'))).toBe(true)
  })

  it('treats application files as first-party code', () => {
    expect(isVendorFrame(frame(APP))).toBe(false)
    expect(isVendorFrame(frame('/app/server/api/orders.ts'))).toBe(false)
  })

  it('judges by the resolved location, not the bundle it came from', () => {
    // A minified chunk that maps back into the app is app code.
    expect(isVendorFrame(frame('/_nuxt/abc.js', 1, APP))).toBe(false)
    expect(isVendorFrame(frame('/_nuxt/abc.js', 1, VUE))).toBe(true)
  })
})

describe('groupFrames', () => {
  it('collapses a run of library frames into one row', () => {
    const groups = groupFrames([
      frame(APP),
      frame(VUE),
      frame(VUE),
      frame(REACTIVITY),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]!.kind).toBe('app')
    expect(groups[1]!.kind).toBe('vendor')
    expect(groups[1]).toMatchObject({ frames: expect.objectContaining({ length: 3 }) })
  })

  it('names the packages in a collapsed run', () => {
    const groups = groupFrames([frame(VUE), frame(VUE), frame(REACTIVITY)])

    expect(groups[0]).toMatchObject({ kind: 'vendor' })
    expect((groups[0] as { label: string }).label).toBe('3 frames in @vue/runtime-core, @vue/reactivity')
  })

  it('keeps application frames separate even between library runs', () => {
    const groups = groupFrames([frame(VUE), frame(APP), frame(VUE)])

    expect(groups.map(g => g.kind)).toEqual(['vendor', 'app', 'vendor'])
  })

  it('preserves the original position of application frames', () => {
    const groups = groupFrames([frame(VUE), frame(APP)])
    const app = groups.find(g => g.kind === 'app')

    expect(app).toMatchObject({ index: 1 })
  })

  it('handles traces that are entirely one kind', () => {
    expect(groupFrames([frame(APP), frame(APP)]).every(g => g.kind === 'app')).toBe(true)
    expect(groupFrames([frame(VUE), frame(VUE)])).toHaveLength(1)
  })

  it('returns nothing for an empty trace', () => {
    expect(groupFrames([])).toEqual([])
  })
})

describe('primaryFrame', () => {
  it('picks the topmost application frame', () => {
    expect(primaryFrame([frame(VUE), frame(APP), frame(VUE)])?.file).toBe(APP)
  })

  it('falls back to the top of the stack when everything is library code', () => {
    expect(primaryFrame([frame(VUE), frame(REACTIVITY)])?.file).toBe(VUE)
  })

  it('returns nothing for an empty trace', () => {
    expect(primaryFrame([])).toBeUndefined()
  })
})

describe('shortPath', () => {
  it('anchors application files at their source directory', () => {
    expect(shortPath('/Users/me/proj/app/pages/index.vue')).toBe('app/pages/index.vue')
    expect(shortPath('../../../../app/pages/ssr-error.vue')).toBe('app/pages/ssr-error.vue')
  })

  it('strips the package manager layout from dependency paths', () => {
    expect(shortPath('/app/node_modules/@vue/runtime-core/dist/x.js'))
      .toBe('@vue/runtime-core/dist/x.js')

    expect(shortPath('/p/node_modules/.pnpm/vue@3.5.0/node_modules/vue/dist/vue.js'))
      .toBe('vue/dist/vue.js')
  })

  it('drops protocols and query strings', () => {
    expect(shortPath('file:///srv/deploy/server/api/x.ts')).toBe('server/api/x.ts')
    expect(shortPath('http://localhost:3000/_nuxt/abc.js?v=123')).toBe('_nuxt/abc.js')
  })

  it('keeps the tail of a path it cannot classify', () => {
    expect(shortPath('/very/deep/unknown/place/file.mjs')).toBe('place/file.mjs')
  })
})

describe('shortLocation', () => {
  it('reports the resolved position when one exists', () => {
    expect(shortLocation(frame('/_nuxt/abc.js', 33, APP))).toBe('app/pages/index.vue:33')
  })

  it('falls back to the raw frame', () => {
    expect(shortLocation(frame('/srv/deploy/server/api/x.ts', 12))).toBe('server/api/x.ts:12')
  })

  it('returns nothing without a frame', () => {
    expect(shortLocation(undefined)).toBeUndefined()
  })
})

/**
 * Vite's dev maps name their sources as a bare filename — no `node_modules/`
 * in front — so a resolved Vue internal looks exactly like application code.
 * Judging on the resolved path alone unfolded every framework frame into the
 * trace, which is the noise the collapsing exists to remove.
 */
describe('vendor frames resolved by a dev sourcemap', () => {
  const viteVendorFrame: MonitorFrame = {
    file: 'http://localhost:3000/_nuxt/@fs/repo/node_modules/.pnpm/@vue+runtime-core@3.5.41/node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js',
    line: 4652,
    column: 16,
    original: {
      file: 'runtime-core.esm-bundler.js',
      line: 4652,
      column: 16,
    },
  }

  it('recognises one by the URL it arrived on', () => {
    expect(isVendorFrame(viteVendorFrame)).toBe(true)
  })

  it('still names the package it belongs to', () => {
    const [group] = groupFrames([viteVendorFrame])

    expect(group?.kind).toBe('vendor')
    expect(group?.kind === 'vendor' && group.label).toContain('@vue/runtime-core')
  })

  /** Application code resolved the same way must not be swept up with it. */
  it('leaves an application frame alone', () => {
    const app: MonitorFrame = {
      file: 'http://localhost:3000/_nuxt/pages/client-error.vue',
      line: 49,
      column: 33,
      original: { file: 'client-error.vue', line: 33, column: 15 },
    }

    expect(isVendorFrame(app)).toBe(false)
  })
})

/**
 * A resolved frame belongs where it resolved to, not where it came from.
 *
 * Server errors arrive on a frame whose raw path is the Nitro bundle. Letting
 * that decide hid the user's own file — snippet and all — inside a collapsed
 * "build output" group, which is the one thing the trace view exists to show.
 */
describe('frames resolved out of a bundle', () => {
  it('treats a frame resolved into application code as application code', () => {
    const frame: MonitorFrame = {
      file: 'file:///repo/example/.nuxt/dev/index.mjs',
      line: 3942,
      column: 11,
      original: { file: '../../server/middleware/fail.ts', line: 9, column: 10 },
    }

    expect(isVendorFrame(frame)).toBe(false)
  })

  it('still collapses one that resolved into a dependency', () => {
    const frame: MonitorFrame = {
      file: 'file:///repo/example/.nuxt/dev/index.mjs',
      line: 2017,
      column: 31,
      original: { file: '../../node_modules/h3/dist/index.mjs', line: 12, column: 1 },
    }

    expect(isVendorFrame(frame)).toBe(true)
  })
})
