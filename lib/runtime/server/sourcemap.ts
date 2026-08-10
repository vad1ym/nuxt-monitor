import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { TraceMap, originalPositionFor, sourceContentFor } from '@jridgewell/trace-mapping'
import type { MonitorFrame } from '../../types'

/**
 * Turns minified stack frames back into source positions.
 *
 * Everything happens against maps already on disk beside the running app, so
 * there is no upload step and no way for the maps to drift out of sync with
 * the build that produced the error.
 */

export interface ResolverOptions {
  /** Where this build's client maps were moved after the build. */
  mapsDir: string
  /**
   * Root holding one directory of maps per build, including this one.
   *
   * A deploy replaces `mapsDir` wholesale, so without an archive every trace
   * from the previous version stops resolving — and those are exactly the
   * traces worth reading in the minutes after a release. Every archived build
   * is searched by asset name rather than selected by release; see
   * `searchDirs` for why that is both sound and necessary.
   */
  archiveDir?: string
  /** Nitro's server output, where server maps sit beside their code. */
  serverDir: string
  /** Usually `/_nuxt/`. */
  baseURL: string
  cdnURL: string
  /** Source lines to show either side of the failing line. */
  contextLines?: number
  /**
   * In dev, nothing is written to disk to read maps from.
   *
   * Vite serves each module transformed, with its map inlined as a base64
   * `sourceMappingURL` comment — and the browser reports frames against
   * exactly those URLs. So the map is fetched back from the dev server that
   * produced it. Off in production, where the maps are on disk and fetching
   * would be both slower and wrong.
   */
  dev?: boolean
}

/** A parsed map together with the directory it was read from. */
interface LoadedMap {
  map: TraceMap
  dir: string
}

/** What a single resolution needs to know about the event it came from. */
export interface ResolveOptions {
  /**
   * Whether the stack was produced by this process.
   *
   * Client stacks arrive through unauthenticated ingest, so the file they name
   * is an attacker's choice and may only resolve against published build
   * assets — never an arbitrary path on disk.
   */
  trusted?: boolean
  /**
   * The release the event was stamped with.
   *
   * Accepted but not used to choose a map: a release name does not identify a
   * build (`dev` is reused, a tag gets rebuilt), so lookups go by asset name
   * across every archived build instead — see `searchDirs`. Kept on the type
   * because callers have it and a future change may want it; it must never
   * become part of a path again, since it arrives through unauthenticated
   * ingest.
   */
  release?: string
}

/**
 * Cache key for a lookup.
 *
 * Trust is part of it: without that, a client-reported frame could be handed a
 * map only a trusted lookup was permitted to read — exactly what the
 * restriction exists to prevent. The release is deliberately *not* part of it;
 * see `searchDirs` for why the asset name alone identifies a build.
 */
function cacheKey(file: string, trusted: boolean): string {
  return `${trusted ? 't' : 'u'}:${file}`
}

/** Whether a resolved path stays within a directory. */
function isInside(dir: string, candidate: string): boolean {
  const root = resolve(dir)
  const target = resolve(candidate)

  return target === root || target.startsWith(`${root}${sep}`)
}

/** Parsed maps are reused; parsing is the expensive part. */
const CACHE_LIMIT = 50

/** The map Vite appends to every module it transforms. */
const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/

export class SourcemapResolver {
  private cache = new Map<string, LoadedMap | null>()

  constructor(private options: ResolverOptions) {}

  /**
   * Resolves every frame it can, leaving the rest untouched.
   *
   * A frame with no map is still useful, so failure here is never fatal.
   */
  resolveStack(stack: string | undefined, options: ResolveOptions = {}): MonitorFrame[] {
    if (!stack) {
      return []
    }

    return parseStack(stack).map(frame => this.resolveFrame(frame, options))
  }

  /**
   * Same, but able to reach the dev server for maps that exist only in memory.
   *
   * Kept apart from `resolveStack` rather than replacing it: in production
   * every map is a file, resolution is synchronous, and there is nothing to
   * await. Only dev pays for the network.
   */
  async resolveStackAsync(stack: string | undefined, options: ResolveOptions = {}): Promise<MonitorFrame[]> {
    if (!stack) {
      return []
    }

    const frames = parseStack(stack)

    if (!this.options.dev) {
      return frames.map(frame => this.resolveFrame(frame, options))
    }

    // Sequential on purpose: a stack repeats the same handful of modules, and
    // the cache is only useful if each is fetched once rather than twenty
    // times at once.
    const out: MonitorFrame[] = []

    for (const frame of frames) {
      await this.loadDevMap(frame.file, options)
      out.push(this.resolveFrame(frame, options))
    }

    return out
  }

  /**
   * Fetches a module back from the dev server and keeps its inlined map.
   *
   * The frame's own file *is* the URL Vite served, so it can be requested
   * verbatim.
   *
   * A failed fetch is *not* remembered. It used to be, on the reasoning that a
   * module which cannot be fetched now will not be fetchable later — true, but
   * it cached a `null` under the same key the on-disk lookup uses, so the disk
   * was never consulted. That is exactly the case a dev server hits when the
   * events it is displaying came from the production build beside it: Vite
   * answers 404 for a hashed asset it never served, while the map for it sits
   * in the archive. Leaving the miss uncached costs one failed fetch per
   * distinct asset and lets the disk answer.
   */
  private async loadDevMap(file: string, options: ResolveOptions): Promise<void> {
    const key = this.keyFor(file, options)

    if (this.cache.has(key) || !this.isDevAsset(file)) {
      return
    }

    try {
      const response = await fetch(file, { signal: AbortSignal.timeout(2_000) })

      if (!response.ok) {
        return
      }

      const inlined = INLINE_MAP.exec(await response.text())

      if (!inlined?.[1]) {
        return
      }

      const json = Buffer.from(inlined[1], 'base64').toString('utf8')

      // Vite inlines `sourcesContent`, so the excerpt comes from the map and
      // no directory is needed to find the original on disk.
      this.remember(key, { map: new TraceMap(JSON.parse(json)), dir: '' })
    }
    catch {
      // Same reasoning as above: a network failure here must not become the
      // cached answer for a lookup the disk could still satisfy.
    }
  }

  /**
   * Whether a frame's URL is one this dev server would have served.
   *
   * Client stacks arrive through unauthenticated ingest, so an unchecked
   * `fetch` here is a request to any address the process can reach, chosen by
   * whoever posted the stack. Restricted to loopback and to the build-asset
   * path Vite serves modules under.
   */
  private isDevAsset(file: string): boolean {
    let url: URL

    try {
      url = new URL(file)
    }
    catch {
      return false
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false
    }

    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'

    return local && url.pathname.startsWith('/_nuxt/')
  }

  /**
   * Every directory that might hold maps, the running build first.
   *
   * Searching them all is safe because a bundler's asset names carry a content
   * hash: `eH5xbD7-.js` names one build's output and nothing else. Measured on
   * consecutive builds of the example, fourteen assets each, zero shared
   * names. So a name that matches inside an archive matches the build that
   * produced it, and the search cannot return the wrong build's map.
   *
   * This replaced looking up one directory by release. A release name does not
   * identify a build — `dev` is reused on every rebuild, and a tag gets built
   * again after a failed deploy — so the lookup went to a directory whose
   * contents had since been replaced, and every frame came back unresolved.
   */
  private searchDirs(): string[] {
    const { archiveDir, mapsDir } = this.options
    const dirs = mapsDir ? [mapsDir] : []

    if (!archiveDir || !existsSync(archiveDir)) {
      return dirs
    }

    try {
      for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue
        }

        const candidate = join(archiveDir, entry.name)

        // The names come from our own build, but the check costs nothing and
        // the directory is on the same disk as the database.
        if (isInside(archiveDir, candidate) && candidate !== mapsDir) {
          dirs.push(candidate)
        }
      }
    }
    catch {
      // An unreadable archive is not a reason to stop resolving.
    }

    return dirs
  }

  private keyFor(file: string, options: ResolveOptions): string {
    return cacheKey(file, options.trusted !== false)
  }

  resolveFrame(frame: MonitorFrame, options: ResolveOptions = {}): MonitorFrame {
    const loaded = this.loadMap(frame.file, options)

    if (!loaded) {
      // Two different failures, and the dashboard has to tell them apart. No
      // map found at all usually means the event came from a build this
      // process cannot see — a dev server showing errors recorded by the
      // production build beside it, most often. Saying "no sourcemap covered
      // this frame" there is simply false: the map exists, it was not reached.
      return { ...frame, unresolved: 'no-map' }
    }

    const { map, dir } = loaded

    // `originalPositionFor` takes a 1-based line and a *0-based* column, while
    // stack traces report both 1-based. Passing the column through unchanged
    // silently shifts every result by one.
    const position = originalPositionFor(map, {
      line: frame.line,
      column: Math.max(0, frame.column - 1),
    })

    // Unmapped positions come back as `{ source: null }` rather than throwing.
    if (!position.source) {
      return { ...frame, unresolved: 'no-mapping' }
    }

    return {
      ...frame,
      original: {
        file: position.source,
        line: position.line ?? 0,
        column: (position.column ?? 0) + 1,
        function: position.name ?? undefined,
        context: this.sourceContext(
          map,
          dir,
          position.source,
          position.line ?? 0,
          options.trusted !== false,
        ),
      },
    }
  }

  /**
   * Source lines around the failure.
   *
   * Prefers `sourcesContent` embedded in the map; Nuxt's builds often omit it,
   * in which case the original file is read from disk — which is available
   * precisely because this runs beside the app it is reporting on.
   */
  private sourceContext(
    map: TraceMap,
    mapDir: string | undefined,
    source: string,
    line: number,
    trusted: boolean,
  ): { line: number, text: string }[] | undefined {
    if (line <= 0) {
      return undefined
    }

    // `sourcesContent` is part of the map that was already cleared for this
    // lookup, so it stays available either way; only the read from disk below
    // is restricted.
    const content = sourceContentFor(map, source) ?? this.readSource(source, mapDir, trusted)

    if (!content) {
      return undefined
    }

    const lines = content.split('\n')
    const radius = this.options.contextLines ?? 4
    const start = Math.max(1, line - radius)
    const end = Math.min(lines.length, line + radius)

    const out: { line: number, text: string }[] = []

    for (let n = start; n <= end; n++) {
      out.push({ line: n, text: lines[n - 1] ?? '' })
    }

    return out
  }

  /**
   * Reads an original source from disk.
   *
   * `sources` entries are written relative to the map file, so they only make
   * sense alongside the directory the map came from — resolving them against
   * anything else silently yields no excerpt, which is the difference between
   * a report that shows the failing line and one that just names it. Reading
   * the file at all is only reasonable because this runs on the machine that
   * built the code.
   *
   * For an untrusted frame that reasoning stops at the map. `candidatePaths`
   * decides which *map* a client-reported frame may open, but a map is a file
   * of paths, and following its `sources` unchecked handed the choice of the
   * next file straight back to whoever posted the stack — `../../../etc/passwd`
   * as a `sources` entry read exactly that, and the lines came back to the
   * dashboard as the excerpt. So the same containment `candidatePaths` applies
   * to the map applies here to the source: inside the map's own directory, and
   * never an absolute path.
   */
  private readSource(source: string, mapDir: string | undefined, trusted: boolean): string | undefined {
    // Strip webpack-style protocol prefixes (`webpack://`, `file://`).
    const cleaned = source.replace(/^[\w-]+:\/\/[^/]*/, '')

    if (!trusted) {
      if (!mapDir || isAbsolute(cleaned)) {
        return undefined
      }

      const inside = resolve(mapDir, cleaned)

      return isInside(mapDir, inside) ? this.readFile(inside) : undefined
    }

    const candidate = isAbsolute(cleaned)
      ? cleaned
      : mapDir
        ? resolve(mapDir, cleaned)
        : undefined

    if (!candidate) {
      return undefined
    }

    return this.readFile(candidate)
  }

  /** Reads a file, treating anything unreadable as simply absent. */
  private readFile(path: string): string | undefined {
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    }
    catch {
      return undefined
    }
  }

  /** Finds and parses the map for a frame's file, caching the result. */
  private loadMap(file: string, options: ResolveOptions): LoadedMap | null {
    const key = this.keyFor(file, options)
    const cached = this.cache.get(key)

    if (cached !== undefined) {
      return cached
    }

    return this.remember(key, this.readMap(file, options))
  }

  /**
   * Caches a lookup, including a miss.
   *
   * Remembering failures matters as much as successes: a stack repeats the
   * same module across frames, and without this each one would retry a read —
   * or, in dev, a fetch — that has already been shown not to work.
   */
  private remember(key: string, map: LoadedMap | null): LoadedMap | null {
    // Crude bound: parsed maps are large and a long-lived process would
    // otherwise accumulate one per asset ever seen.
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value

      if (oldest !== undefined) {
        this.cache.delete(oldest)
      }
    }

    this.cache.set(key, map)

    return map
  }

  private readMap(file: string, options: ResolveOptions): LoadedMap | null {
    for (const candidate of this.candidatePaths(file, options)) {
      try {
        if (existsSync(candidate)) {
          return {
            map: new TraceMap(readFileSync(candidate, 'utf8')),
            // Kept so relative `sources` entries can be resolved later.
            dir: dirname(candidate),
          }
        }
      }
      catch {
        // Unreadable or malformed map: try the next candidate.
      }
    }

    return null
  }

  /**
   * Where the map for a given frame might live.
   *
   * Browser frames arrive as URLs and resolve under the relocated maps
   * directory; server frames arrive as file paths whose maps sit beside them.
   *
   * The running build is tried first, then each archived one — see
   * `searchDirs` for why matching on the asset name across them is sound.
   */
  private candidatePaths(file: string, options: ResolveOptions): string[] {
    const out: string[] = []
    const asset = this.toAssetPath(file)

    if (asset) {
      for (const dir of this.searchDirs()) {
        // `join` normalises `..` away, so a frame naming
        // `/_nuxt/../../../etc/passwd` resolved to a path outside the maps
        // directory entirely. Client stacks arrive through unauthenticated
        // ingest, which made the choice of file to read an attacker's.
        const candidate = join(dir, `${asset}.map`)

        if (isInside(dir, candidate)) {
          out.push(candidate)
        }
      }
    }

    // Absolute paths and reads outside the build directories are for stacks
    // this process produced itself. A browser can claim any path it likes.
    if (options.trusted === false) {
      return out
    }

    const local = file.replace(/^file:\/\//, '')

    if (isAbsolute(local)) {
      out.push(`${local}.map`)
    }
    else if (this.options.serverDir) {
      out.push(resolve(this.options.serverDir, `${local}.map`))
    }

    return out
  }

  /**
   * Converts a browser-reported URL into a path under the build assets
   * directory, stripping the CDN origin and app base along the way.
   */
  private toAssetPath(file: string): string | undefined {
    let path = file

    if (this.options.cdnURL && path.startsWith(this.options.cdnURL)) {
      path = path.slice(this.options.cdnURL.length)
    }
    else if (/^https?:\/\//.test(path)) {
      try {
        path = new URL(path).pathname
      }
      catch {
        return undefined
      }
    }

    const base = this.options.baseURL

    if (base && base !== '/' && path.startsWith(base)) {
      path = path.slice(base.length)
    }

    return path.replace(/^\/+/, '') || undefined
  }
}

/**
 * Frame layouts, written so each part can only match one way.
 *
 * The obvious spelling — `(.+?)\s+\(` beside `(.+?):(\d+):(\d+)` — lets the
 * two lazy groups trade characters, so a line that *nearly* matches makes the
 * engine try every split between them. Measured on the previous version: a
 * single 64 KB line took 1.2 seconds of CPU, growing quadratically with
 * length. Stacks arrive through unauthenticated ingest, which made that an
 * unauthenticated way to occupy the event loop.
 *
 * Two things are excluded from each group, and both matter. Excluding the
 * delimiter — `(`, `@`, or the `:digits` run that ends the file — stops a
 * group from swallowing what terminates it. Excluding *leading whitespace*
 * stops it trading characters with the `\s+` before it; addressing only the
 * first left a line of 800 spaces costing half a second, growing cubically.
 *
 * With both, every layout parses identically and a 10 KB hostile line takes no
 * measurable time.
 */
const FRAME_PATTERNS = [
  // Chrome/Node: "at fn (/path/file.js:1:2)" and "at /path/file.js:1:2"
  //
  // A function name may contain spaces ("async fn", "Object.<anonymous>"), so
  // `[^(]*?` and the `\s+` before `\(` still overlap and the rule still
  // reports it. Measured rather than argued: 4 KB of the worst input costs
  // 12 ms and grows quadratically, against a 10 KB ceiling on the stack an
  // event may carry. Removing the last of it would mean refusing names with
  // spaces, which loses real frames to save nothing.
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  /^\s*at\s+(?:([^(\s][^(]*?)\s+\()?([^:\s][^:]*(?::[^:]*)*?):(\d+):(\d+)\)?$/,
  // Firefox/Safari: "fn@/path/file.js:1:2"
  /^\s*(?:([^@\s]*)@)?([^:\s][^:]*(?::[^:]*)*?):(\d+):(\d+)$/,
]

/**
 * Parses a stack string into frames.
 *
 * Handles both the V8 and the Firefox/Safari layouts, since client errors
 * arrive from whatever browser the user happened to be running.
 */
export function parseStack(stack: string): MonitorFrame[] {
  const frames: MonitorFrame[] = []

  for (const raw of stack.split('\n')) {
    const line = raw.trim()

    if (!line || line.startsWith('Error') || line.startsWith('TypeError')) {
      // The header line carries the message, not a frame.
      if (!line.includes(':') || !/:\d+:\d+/.test(line)) {
        continue
      }
    }

    for (const pattern of FRAME_PATTERNS) {
      const match = pattern.exec(line)

      if (!match) {
        continue
      }

      const [, fn, file, lineNo, column] = match

      if (!file) {
        continue
      }

      frames.push({
        file: file.replace(/^\(/, ''),
        line: Number(lineNo),
        column: Number(column),
        function: fn?.trim() || undefined,
      })

      break
    }
  }

  return frames
}
