import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SourcemapResolver, isSafeRelease, parseStack } from './sourcemap'

describe('parseStack', () => {
  it('parses V8 frames with and without a function name', () => {
    const frames = parseStack([
      'TypeError: boom',
      '    at handler (/app/server/api/x.ts:3:9)',
      '    at /app/server/index.ts:12:1',
    ].join('\n'))

    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({
      file: '/app/server/api/x.ts',
      line: 3,
      column: 9,
      function: 'handler',
    })
    expect(frames[1]).toMatchObject({ file: '/app/server/index.ts', line: 12, column: 1 })
  })

  it('parses the Firefox and Safari layout', () => {
    const frames = parseStack([
      'boom@https://example.com/_nuxt/abc.js:1:842',
      '@https://example.com/_nuxt/abc.js:1:100',
    ].join('\n'))

    expect(frames[0]).toMatchObject({
      file: 'https://example.com/_nuxt/abc.js',
      line: 1,
      column: 842,
      function: 'boom',
    })
    expect(frames[1]?.function).toBeUndefined()
  })

  it('parses browser URLs with a port', () => {
    const frames = parseStack('    at fn (http://localhost:3000/_nuxt/x.js:1:5)')

    expect(frames[0]).toMatchObject({
      file: 'http://localhost:3000/_nuxt/x.js',
      line: 1,
      column: 5,
    })
  })

  it('skips the header and returns nothing for a message-only stack', () => {
    expect(parseStack('TypeError: cannot read properties of null')).toEqual([])
    expect(parseStack('')).toEqual([])
  })

  /**
   * Stacks arrive through unauthenticated ingest, so a line that nearly
   * matches must not be expensive.
   *
   * The earlier patterns let two lazy groups trade characters, which made a
   * near-match cost quadratic time — a single 64 KB line took 1.2 seconds of
   * CPU, and the event loop is single-threaded. The budget here is deliberately
   * loose: it is checking for catastrophic backtracking, not benchmarking.
   */
  it('does not backtrack catastrophically on a hostile line', () => {
    // Both shapes that broke a previous version of these patterns: a run of
    // the delimiter, and a run of whitespace after `at`. The second is the one
    // that survived the first fix — 800 spaces cost half a second, and the
    // ingest limit allows a 10 KB line.
    const hostile = [
      `${'@'.repeat(10_000)}:x`,
      `    at ${' '.repeat(10_000)}x`,
      `    at ${' '.repeat(5_000)}(${' '.repeat(5_000)}`,
    ]

    for (const line of hostile) {
      const started = performance.now()
      parseStack(line)

      expect(performance.now() - started).toBeLessThan(100)
    }
  })

  it('still parses every layout after that change', () => {
    const frames = parseStack([
      'Error: boom',
      '    at handler (/app/server/api/x.ts:3:9)',
      '    at /app/server/index.ts:12:1',
      '    at fn (http://localhost:3000/_nuxt/x.js:1:5)',
      'boom@https://example.com/_nuxt/abc.js:1:842',
      '@https://example.com/_nuxt/abc.js:1:100',
    ].join('\n'))

    expect(frames.map(frame => [frame.file, frame.line, frame.column])).toEqual([
      ['/app/server/api/x.ts', 3, 9],
      ['/app/server/index.ts', 12, 1],
      ['http://localhost:3000/_nuxt/x.js', 1, 5],
      ['https://example.com/_nuxt/abc.js', 1, 842],
      ['https://example.com/_nuxt/abc.js', 1, 100],
    ])
  })
})

describe('SourcemapResolver', () => {
  let dir: string
  let mapsDir: string

  const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

  /** Base64-VLQ, as the source map spec defines it. */
  function vlq(value: number): string {
    let rest = value < 0 ? ((-value) << 1) | 1 : value << 1
    let out = ''

    do {
      let digit = rest & 31
      rest >>>= 5

      if (rest > 0) {
        digit |= 32
      }

      out += BASE64[digit]
    } while (rest > 0)

    return out
  }

  /**
   * A hand-built map for a one-line "bundle".
   *
   * Encoding the segment here rather than pasting an opaque string is what
   * makes the column convention assertable: the mapping below says generated
   * column 10 (0-based) is source line 3, column 7 (1-based), and the tests
   * check exactly that translation.
   */
  function writeMap(into: string = mapsDir, sourceLine = 3): void {
    mkdirSync(join(into, '_nuxt'), { recursive: true })

    // [generatedColumn, sourceIndex, sourceLine (0-based), sourceColumn, nameIndex]
    const mappings = [10, 0, sourceLine - 1, 6, 0].map(vlq).join('')

    writeFileSync(join(into, '_nuxt', 'app.js.map'), JSON.stringify({
      version: 3,
      file: 'app.js',
      sources: ['../../src/pages/index.vue'],
      sourcesContent: ['line one\nline two\nconst broken = null\nline four\nline five\n'],
      names: ['broken'],
      mappings,
    }))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monitor-map-'))
    mapsDir = join(dir, 'maps')
    writeMap()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeResolver(): SourcemapResolver {
    return new SourcemapResolver({
      mapsDir,
      serverDir: join(dir, 'server'),
      baseURL: '/',
      cdnURL: '',
      contextLines: 2,
    })
  }

  it('maps a browser URL to the relocated map and resolves the position', () => {
    const resolved = makeResolver().resolveFrame({
      file: 'http://localhost:3000/_nuxt/app.js',
      line: 1,
      column: 11,
    })

    expect(resolved.original?.file).toBe('../../src/pages/index.vue')
    expect(resolved.original?.line).toBe(3)
  })

  it('converts the column between the stack and the map conventions', () => {
    const resolver = makeResolver()

    // Stack columns are 1-based; the mapping is at 0-based generated column
    // 10, so the frame reporting column 11 is the one that must resolve.
    expect(resolver.resolveFrame({ file: '/_nuxt/app.js', line: 1, column: 11 }).original?.line).toBe(3)

    // And the mapped source column comes back 1-based.
    expect(resolver.resolveFrame({ file: '/_nuxt/app.js', line: 1, column: 11 }).original?.column).toBe(7)
  })

  it('includes source context around the failing line', () => {
    const resolved = makeResolver().resolveFrame({
      file: '/_nuxt/app.js',
      line: 1,
      column: 11,
    })

    const context = resolved.original?.context

    expect(context).toBeDefined()
    expect(context!.find(entry => entry.line === 3)?.text).toBe('const broken = null')
    // contextLines is 2, so lines 1..5 around line 3.
    expect(context!.at(0)?.line).toBe(1)
    expect(context!.at(-1)?.line).toBe(5)
  })

  it('reads the source from disk when the map omits sourcesContent', () => {
    // Nuxt's production maps carry no `sourcesContent`, and their `sources`
    // are relative to the map file. Resolving them against anything else
    // yields a frame that names the line but cannot show it — which is the
    // difference between a useful report and a file path to go open yourself.
    mkdirSync(join(dir, 'src', 'pages'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'pages', 'ondisk.vue'),
      'one\ntwo\nconst broken = null\nfour\nfive\n',
    )

    const mappings = [10, 0, 2, 6, 0].map(vlq).join('')

    writeFileSync(join(mapsDir, '_nuxt', 'ondisk.js.map'), JSON.stringify({
      version: 3,
      file: 'ondisk.js',
      // Relative to the map, which sits in `<dir>/maps/_nuxt`.
      sources: ['../../src/pages/ondisk.vue'],
      names: ['broken'],
      mappings,
      // Deliberately no sourcesContent.
    }))

    const resolved = makeResolver().resolveFrame({
      file: '/_nuxt/ondisk.js',
      line: 1,
      column: 11,
    })

    expect(resolved.original?.line).toBe(3)
    expect(resolved.original?.context?.find(e => e.line === 3)?.text).toBe('const broken = null')
  })

  it('reports no context when the original file is gone', () => {
    writeFileSync(join(mapsDir, '_nuxt', 'missing-src.js.map'), JSON.stringify({
      version: 3,
      file: 'missing-src.js',
      sources: ['../../src/pages/deleted.vue'],
      names: [],
      mappings: [10, 0, 2, 6].map(vlq).join(''),
    }))

    const resolved = makeResolver().resolveFrame({
      file: '/_nuxt/missing-src.js',
      line: 1,
      column: 11,
    })

    // Still resolves the position; only the excerpt is unavailable.
    expect(resolved.original?.line).toBe(3)
    expect(resolved.original?.context).toBeUndefined()
  })

  it('leaves a frame usable when no map exists, and says why', () => {
    const frame = { file: '/_nuxt/missing.js', line: 1, column: 1 }
    const resolved = makeResolver().resolveFrame(frame)

    // Still a frame somebody can read — failure here is never fatal.
    expect(resolved).toMatchObject(frame)
    expect(resolved.original).toBeUndefined()
    expect(resolved.unresolved).toBe('no-map')
  })

  it('leaves a frame untouched when the position is not mapped', () => {
    const resolved = makeResolver().resolveFrame({
      file: '/_nuxt/app.js',
      line: 99,
      column: 1,
    })

    expect(resolved.original).toBeUndefined()
  })

  it('strips the app base URL before looking for the map', () => {
    const resolver = new SourcemapResolver({
      mapsDir,
      serverDir: '',
      baseURL: '/app/',
      cdnURL: '',
    })

    expect(resolver.resolveFrame({ file: '/app/_nuxt/app.js', line: 1, column: 11 }).original).toBeDefined()
  })

  it('strips a CDN origin before looking for the map', () => {
    const resolver = new SourcemapResolver({
      mapsDir,
      serverDir: '',
      baseURL: '/',
      cdnURL: 'https://cdn.example.com/',
    })

    expect(
      resolver.resolveFrame({ file: 'https://cdn.example.com/_nuxt/app.js', line: 1, column: 11 }).original,
    ).toBeDefined()
  })

  it('resolves whole stacks and passes unmappable frames through', () => {
    const frames = makeResolver().resolveStack([
      'TypeError: boom',
      '    at fn (/_nuxt/app.js:1:11)',
      '    at other (/_nuxt/missing.js:5:5)',
    ].join('\n'))

    expect(frames).toHaveLength(2)
    expect(frames[0]?.original?.line).toBe(3)
    expect(frames[1]?.original).toBeUndefined()
  })

  it('returns nothing for a missing stack', () => {
    expect(makeResolver().resolveStack(undefined)).toEqual([])
  })

  it('survives a malformed map file', () => {
    writeFileSync(join(mapsDir, '_nuxt', 'bad.js.map'), '{ not valid json')

    expect(() =>
      makeResolver().resolveFrame({ file: '/_nuxt/bad.js', line: 1, column: 1 }),
    ).not.toThrow()
  })
})

/**
 * Dev resolution.
 *
 * In dev nothing is written to disk, so the map cannot be read from a file.
 * Vite serves each module transformed with its map inlined as base64, and the
 * browser reports frames against exactly those URLs — so the map is fetched
 * back from the dev server that produced it.
 */
describe('SourcemapResolver in dev', () => {
  const MODULE_URL = 'http://localhost:3000/_nuxt/pages/broken.vue'

  /** A map whose line 40 came from line 4 of the original. */
  function inlineModule(): string {
    const map = {
      version: 3,
      sources: ['broken.vue'],
      sourcesContent: ['<script setup>\nconst item = null\n</script>\n<template>{{ item.label }}</template>\n'],
      names: [],
      // Generated 40:0 -> source 0, original 4:0.
      mappings: `${';'.repeat(39)}AAGA`,
    }

    const encoded = Buffer.from(JSON.stringify(map)).toString('base64')

    return `const x = 1\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${encoded}`
  }

  let fetched: string[]
  const realFetch = globalThis.fetch

  beforeEach(() => {
    fetched = []

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input))

      return new Response(inlineModule(), { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function devResolver(): SourcemapResolver {
    return new SourcemapResolver({
      mapsDir: '/nowhere',
      serverDir: '/nowhere',
      baseURL: '/',
      cdnURL: '',
      dev: true,
    })
  }

  it('resolves a frame through the map Vite inlined', async () => {
    const [frame] = await devResolver().resolveStackAsync(
      `TypeError: boom\n    at render (${MODULE_URL}:40:1)`,
    )

    expect(frame?.original?.file).toBe('broken.vue')
    expect(frame?.original?.line).toBe(4)
  })

  /** `sourcesContent` is inlined, so the excerpt needs no file on disk. */
  it('takes the excerpt from the map itself', async () => {
    const [frame] = await devResolver().resolveStackAsync(
      `TypeError: boom\n    at render (${MODULE_URL}:40:1)`,
    )

    const text = (frame?.original?.context ?? []).map(line => line.text).join('\n')

    expect(text).toContain('{{ item.label }}')
  })

  it('fetches each module once, however many frames it appears in', async () => {
    await devResolver().resolveStackAsync([
      'TypeError: boom',
      `    at a (${MODULE_URL}:40:1)`,
      `    at b (${MODULE_URL}:40:9)`,
      `    at c (${MODULE_URL}:40:2)`,
    ].join('\n'))

    expect(fetched).toEqual([MODULE_URL])
  })

  it('leaves the frame alone when the module cannot be fetched', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused')
    }) as typeof fetch

    const [frame] = await devResolver().resolveStackAsync(
      `TypeError: boom\n    at render (${MODULE_URL}:40:1)`,
    )

    // Unresolved is a worse report, not a broken one.
    expect(frame?.original).toBeUndefined()
    expect(frame?.line).toBe(40)
  })

  /** Production reads maps from disk; fetching there would be wrong and slow. */
  it('does not reach the network when dev is off', async () => {
    const resolver = new SourcemapResolver({
      mapsDir: '/nowhere',
      serverDir: '/nowhere',
      baseURL: '/',
      cdnURL: '',
    })

    await resolver.resolveStackAsync(`TypeError: boom\n    at render (${MODULE_URL}:40:1)`)

    expect(fetched).toEqual([])
  })
})

/**
 * Client stacks arrive through unauthenticated ingest, so the file a frame
 * names is chosen by whoever posted it. Resolution has to treat that as
 * hostile input rather than as a path.
 */
describe('SourcemapResolver and untrusted stacks', () => {
  function resolver(): SourcemapResolver {
    return new SourcemapResolver({
      mapsDir: '/app/.output/monitor/maps',
      serverDir: '/app/.output/server',
      baseURL: '/',
      cdnURL: '',
    })
  }

  /** Access to the private helper, which is the whole of the boundary. */
  function candidates(file: string, trusted: boolean, release?: string): string[] {
    return (resolver() as unknown as {
      candidatePaths: (file: string, options: { trusted: boolean, release?: string }) => string[]
    }).candidatePaths(file, { trusted, release })
  }

  it('never escapes the maps directory, however the frame is spelled', () => {
    for (const path of candidates('/_nuxt/../../../../etc/passwd', false)) {
      expect(path.startsWith('/app/.output/monitor/maps/')).toBe(true)
    }
  })

  it('refuses an absolute path from a client frame', () => {
    expect(candidates('/etc/shadow', false).includes('/etc/shadow.map')).toBe(false)
  })

  /** Server stacks come from this process, so they may name their own files. */
  it('still reads beside the bundle for a server frame', () => {
    expect(candidates('/app/.output/server/chunks/nitro.mjs', true))
      .toContain('/app/.output/server/chunks/nitro.mjs.map')
  })

  it('does not hand an untrusted lookup a trusted result from cache', () => {
    const shared = resolver()
    const load = (shared as unknown as {
      loadMap: (file: string, options: { trusted: boolean }) => unknown
    }).loadMap.bind(shared)

    // A trusted miss must not answer the untrusted question that follows.
    load('/app/.output/server/x.mjs', { trusted: true })

    const cache = (shared as unknown as { cache: Map<string, unknown> }).cache

    expect([...cache.keys()].every(key => key.startsWith('t:') || key.startsWith('u:'))).toBe(true)
  })
})

/**
 * Resolution against a release that is no longer deployed.
 *
 * The archive exists for the minutes after a deploy, when errors arrive from
 * the version being replaced and from the one replacing it at once. The two
 * builds name the same asset, so the test gives each a map pointing at a
 * different source line — resolving to the wrong one is the failure this
 * guards against, and it is invisible unless the lines differ.
 */
/**
 * Resolution against builds that are no longer deployed.
 *
 * The archive exists for the minutes after a deploy, when errors arrive from
 * the version being replaced and from the one replacing it at once.
 */
describe('SourcemapResolver across builds', () => {
  let dir: string

  const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

  function vlq(value: number): string {
    let rest = value < 0 ? ((-value) << 1) | 1 : value << 1
    let out = ''

    do {
      let digit = rest & 31
      rest >>>= 5

      if (rest > 0) {
        digit |= 32
      }

      out += BASE64[digit]
    } while (rest > 0)

    return out
  }

  /** Writes a map for `_nuxt/<asset>.js` whose single mapping names `sourceLine`. */
  function writeMapInto(into: string, asset: string, sourceLine: number): void {
    mkdirSync(join(into, '_nuxt'), { recursive: true })

    const mappings = [10, 0, sourceLine - 1, 6, 0].map(vlq).join('')

    writeFileSync(join(into, '_nuxt', `${asset}.js.map`), JSON.stringify({
      version: 3,
      file: `${asset}.js`,
      sources: ['../../src/pages/index.vue'],
      sourcesContent: ['one\ntwo\nthree\nfour\nfive\nsix\nseven\n'],
      names: ['broken'],
      mappings,
    }))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monitor-build-'))

    // Asset names carry a content hash, so each build produces its own —
    // measured on real output, where consecutive builds of the example share
    // none of their fourteen names. That is what makes the name enough to
    // identify which build a frame came from, and why searching every
    // archived build cannot return the wrong one's map.
    writeMapInto(join(dir, 'maps'), 'live', 3)
    writeMapInto(join(dir, 'archive', 'b1c2d3e4f5a6'), 'older', 6)
    writeMapInto(join(dir, 'archive', 'a6f5e4d3c2b1'), 'oldest', 7)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeResolver(): SourcemapResolver {
    return new SourcemapResolver({
      mapsDir: join(dir, 'maps'),
      serverDir: join(dir, 'server'),
      archiveDir: join(dir, 'archive'),
      release: '2.0.0',
      baseURL: '/',
      cdnURL: '',
    })
  }

  const at = (asset: string) => ({ file: `/_nuxt/${asset}.js`, line: 1, column: 11 })

  it('resolves a frame from the running build', () => {
    expect(makeResolver().resolveFrame(at('live')).original?.line).toBe(3)
  })

  /**
   * The whole point of the archive: a deploy replaced the build these came
   * from, and their frames still have to reach source.
   */
  it('resolves frames from builds that have since been replaced', () => {
    const resolver = makeResolver()

    expect(resolver.resolveFrame(at('older')).original?.line).toBe(6)
    expect(resolver.resolveFrame(at('oldest')).original?.line).toBe(7)
  })

  it('answers each asset with its own build, through one cache', () => {
    const shared = makeResolver()

    expect(shared.resolveFrame(at('older')).original?.line).toBe(6)
    expect(shared.resolveFrame(at('live')).original?.line).toBe(3)
    expect(shared.resolveFrame(at('oldest')).original?.line).toBe(7)
    // And again, now that all three are cached.
    expect(shared.resolveFrame(at('older')).original?.line).toBe(6)
  })

  /**
   * The release no longer selects a directory, so it cannot steer a lookup
   * anywhere — including somewhere it should not go. It still arrives on an
   * event, and an event's fields come through unauthenticated ingest.
   */
  it('ignores the release entirely when choosing a map', () => {
    const resolver = makeResolver()

    for (const release of ['../../etc', '..', '1.0.0', 'x y', undefined]) {
      expect(resolver.resolveFrame(at('older'), { release }).original?.line).toBe(6)
    }

    // The guard itself still holds, for anything else that builds a path.
    expect(isSafeRelease('../../etc')).toBe(false)
    expect(isSafeRelease('1.4.0')).toBe(true)
  })

  /**
   * "No sourcemap covered this frame" is false when no map was ever found —
   * it sends somebody hunting for a missing map that is on disk one directory
   * away, when the real answer is that the event came from another build.
   */
  it('says which kind of failure an unresolved frame hit', () => {
    const resolver = makeResolver()

    expect(resolver.resolveFrame(at('absent')).unresolved).toBe('no-map')

    expect(resolver.resolveFrame({ file: '/_nuxt/live.js', line: 99, column: 1 }).unresolved)
      .toBe('no-mapping')

    expect(resolver.resolveFrame(at('live')).unresolved).toBeUndefined()
  })

  it('still refuses a frame that would escape the maps directories', () => {
    const escaping = makeResolver().resolveFrame({
      file: '/_nuxt/../../../../etc/passwd',
      line: 1,
      column: 1,
    })

    expect(escaping.original).toBeUndefined()
  })
})

describe('SourcemapResolver dev fetches', () => {
  function isDevAsset(file: string): boolean {
    const resolver = new SourcemapResolver({
      mapsDir: '/x',
      serverDir: '/x',
      baseURL: '/',
      cdnURL: '',
      dev: true,
    })

    return (resolver as unknown as { isDevAsset: (file: string) => boolean }).isDevAsset(file)
  }

  /** An unchecked fetch here is a request to any host, chosen by the reporter. */
  it('only fetches build assets from the local dev server', () => {
    expect(isDevAsset('http://localhost:3000/_nuxt/pages/x.vue')).toBe(true)
    expect(isDevAsset('http://127.0.0.1:3000/_nuxt/x.js')).toBe(true)

    expect(isDevAsset('http://evil.example.com/_nuxt/x.js')).toBe(false)
    expect(isDevAsset('http://localhost:3000/admin/secrets')).toBe(false)
    expect(isDevAsset('file:///etc/passwd')).toBe(false)
    expect(isDevAsset('not a url')).toBe(false)
  })
})
