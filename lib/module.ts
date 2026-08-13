import type { Nuxt } from '@nuxt/schema'
import type { Nitro } from 'nitropack'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import {
  addImports,
  addPlugin,
  addServerHandler,
  addServerImports,
  addServerPlugin,
  createResolver,
  defineNuxtModule,
  useLogger,
} from '@nuxt/kit'
import { defu } from 'defu'
import type { MonitorOptions } from './types'

const logger = useLogger('nuxt-monitor')

export type { MonitorOptions } from './types'

export default defineNuxtModule<MonitorOptions>({
  meta: {
    name: 'nuxt-monitor',
    configKey: 'monitor',
    compatibility: { nuxt: '>=4.0.0' },
  },
  defaults: {
    enabled: true,
    route: '/_monitor',
    storageDir: '.monitor',
    databaseUrl: '',
    release: '',
    retentionDays: 14,
    maxEventsPerIssue: 100,
    maxIssues: 5_000,
    maxDatabaseMb: 256,
    keepSourcemapsFor: 5,
    scrubKeys: [],
    capture: {},
    ignore: {},
    notifications: {},
    sampling: {},
    groups: {},
    auth: {
      username: 'admin',
      sessionTtl: 60 * 60 * 24 * 7,
    },
  },
  async setup(options, nuxt) {
    if (options.enabled === false) {
      return
    }

    const resolver = createResolver(import.meta.url)
    const route = normalizeRoute(options.route!)

    warnIfUnprotected(options, nuxt)

    // Resolved to absolute here, at build time: the process cwd in production
    // is not necessarily the app root, so a relative path would resolve
    // somewhere else once deployed.
    const storageDir = resolve(nuxt.options.rootDir, options.storageDir!)

    // Resolved at build time, so the value describes the build it is stamped
    // into rather than whatever the server process happens to see later.
    const release = resolveRelease(options.release)

    nuxt.options.runtimeConfig.monitor = defu(
      nuxt.options.runtimeConfig.monitor as Record<string, unknown> | undefined,
      {
        route,
        storageDir,
        // `?? ''` rather than the bare option: `defu` drops `undefined`
        // entirely, and Nuxt only applies a `NUXT_*` override to a key that
        // already exists in `runtimeConfig`. Without a value here the key was
        // absent, `NUXT_MONITOR_DATABASE_URL` was silently ignored, and the
        // app wrote to SQLite while reporting no error at all.
        databaseUrl: options.databaseUrl ?? '',
        release,
        retentionDays: options.retentionDays,
        maxEventsPerIssue: options.maxEventsPerIssue,
        maxIssues: options.maxIssues,
        maxDatabaseMb: options.maxDatabaseMb,
        scrubKeys: options.scrubKeys,
        capture: options.capture,
        ignore: options.ignore,
        sampling: options.sampling,
        groups: options.groups,
        // Private half, like `auth`: a channel carries a bot token, and the
        // public half of `runtimeConfig` is serialized into the page.
        notifications: {
          ...options.notifications,
          // Spelled out with `?? ''` for the same reason `databaseUrl` is: Nuxt
          // only applies a `NUXT_*` override to a key already present in
          // `runtimeConfig`, and `defu` drops `undefined` outright. Without
          // these three keys existing, `NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_TOKEN`
          // is silently ignored and the only place left for a bot token is the
          // config file — where it is baked into the build artefact.
          telegramToken: options.notifications?.telegramToken ?? '',
          telegramChatId: options.notifications?.telegramChatId ?? '',
          webhookUrl: options.notifications?.webhookUrl ?? '',
          dashboardUrl: options.notifications?.dashboardUrl ?? '',
        },
        // Secrets live under the private half of runtimeConfig, so they are
        // never serialized into the client payload.
        auth: {
          username: options.auth?.username,
          passwordHash: options.auth?.passwordHash,
          password: options.auth?.password,
          secret: options.auth?.secret,
          sessionTtl: options.auth?.sessionTtl,
          optional: resolveOptionalAuth(options.auth?.optional, nuxt.options.dev),
        },
        // Needed to turn a browser-reported URL back into a file on disk.
        baseURL: nuxt.options.app.baseURL,
        cdnURL: nuxt.options.app.cdnURL,
        // Filled in below once Nitro's output paths are known.
        mapsDir: '',
        serverDir: '',
        archiveDir: '',
      },
    )

    // The browser collector needs the ingest route, and only this half of
    // runtimeConfig reaches it. Nothing secret goes here.
    nuxt.options.runtimeConfig.public.monitor = defu(
      nuxt.options.runtimeConfig.public.monitor as Record<string, unknown> | undefined,
      { route, release },
    )

    enableClientSourcemaps(nuxt)
    enableServerSourcemaps(nuxt)
    relocateClientSourcemaps(nuxt, {
      // Beside the database, not inside `.output`: the point of the archive is
      // to survive the build that replaces it.
      dir: join(storageDir, 'maps'),
      release,
      keep: options.keepSourcemapsFor ?? 5,
    })

    // Collectors. The server side is a single Nitro `error` hook — every
    // server error path funnels through `captureError` into it.
    addServerPlugin(resolver.resolve('./runtime/server/plugin'))
    addPlugin({ src: resolver.resolve('./runtime/app/collector.client'), mode: 'client' })
    addPlugin({ src: resolver.resolve('./runtime/app/collector'), mode: 'all' })

    // `useMonitor()` in app code, `exception()` in server code. Two entry
    // points rather than one because most manual reports are made in a server
    // route, where there is no Nuxt app to reach a composable through.
    addImports({
      name: 'useMonitor',
      from: resolver.resolve('./runtime/app/composables'),
    })

    addServerImports([{
      name: 'exception',
      from: resolver.resolve('./runtime/server/exception'),
    }])

    // Ingest stays outside the auth check — the browser posts to it.
    addServerHandler({
      route: `${route}/api/ingest`,
      method: 'post',
      handler: resolver.resolve('./runtime/server/routes/ingest'),
    })

    // Registered unconditionally; each handler answers 404 while no
    // credentials resolve, so an unprotected install exposes nothing.
    registerDashboard(nuxt, resolver, route)
  },
})

/**
 * Whether the dashboard may be served without a password.
 *
 * Decided here, at build time, and deliberately not at request time.
 * `import.meta.dev` is a runtime value, so gating on it in the handler would
 * leave the unauthenticated dashboard one stray `NODE_ENV` away from a
 * production server. Resolving it into the build instead means the production
 * artefact simply has no flag left to flip: whatever the config said, what
 * ships is `false`.
 *
 * That asymmetry is the point. A dashboard lists your routes, your stack
 * traces and your source — reconnaissance handed over for free — so the
 * failure mode of an accidentally-committed `optional: true` has to be
 * "nothing happens in production", not "the dashboard is open".
 *
 * Defaults to on in dev: an unprotected dashboard on localhost is a
 * convenience, and requiring a password to read your own errors is friction
 * with nothing behind it.
 */
export function resolveOptionalAuth(configured: boolean | undefined, dev: boolean): boolean {
  return dev && configured !== false
}

/**
 * The version string stamped on every event.
 *
 * Falls back to whatever the platform already knows, because the setting that
 * has to be remembered for each deploy is the one that is missing when it
 * matters. A commit SHA is not a friendly version, but it is unambiguous and
 * it is there for free — the alternative is an empty facet.
 */
function resolveRelease(configured: string | undefined): string {
  const candidate = configured
    || process.env.NUXT_MONITOR_RELEASE
    || process.env.GITHUB_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.CF_PAGES_COMMIT_SHA
    || process.env.COMMIT_REF
    || ''

  // Long SHAs are unreadable in a facet list and the first seven identify a
  // commit perfectly well.
  return /^[0-9a-f]{40}$/i.test(candidate) ? candidate.slice(0, 7) : candidate.slice(0, 64)
}

/** `/_monitor/` and `_monitor` both mean `/_monitor`. */
function normalizeRoute(route: string): string {
  const withLeading = route.startsWith('/') ? route : `/${route}`
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading
}

/**
 * Warns when a production build carries no credentials.
 *
 * Whether the dashboard actually answers is decided per request, from the
 * credentials present at that moment — building without a password and
 * supplying `NUXT_MONITOR_AUTH_PASSWORD` when the server starts is a perfectly
 * ordinary deployment, and baking the decision in at build time would leave
 * those installs permanently locked out with no way to recover. This is only a
 * heads-up for the common case of forgetting entirely.
 */
function warnIfUnprotected(options: MonitorOptions, nuxt: Nuxt): void {
  const hasSecret = Boolean(options.auth?.passwordHash || options.auth?.password)

  if (hasSecret || nuxt.options.dev) {
    return
  }

  logger.warn(
    'No `monitor.auth.password` or `monitor.auth.passwordHash` is set, so the dashboard will '
    + 'return 404 unless `NUXT_MONITOR_AUTH_PASSWORD` is set when the server starts. '
    + 'Errors are collected either way.',
  )
}

/**
 * Server traces need two settings, and each fails silently on its own.
 *
 * `sourcemap.server` defaults to `false`, so no usable map is written at all.
 * Server maps never reach a browser, so unlike the client there is nothing to
 * hide and `true` is the right value.
 *
 * The second is less obvious. Nitro ships a `sourcemap-minify` plugin that
 * blanks `mappings` on any map whose `sources` mention `node_modules` — a size
 * optimisation, and a reasonable one when nobody reads the maps. But the
 * server bundle mixes application code with vendor code in one chunk, so the
 * rule catches the chunk holding *your* handlers too. The `.map` still exists
 * and still lists `server/middleware/fail.ts`, which is what makes this so
 * quiet: the resolver finds a file, parses it happily, and gets null for every
 * position. A middleware throw then reports `nitro.mjs:6416` while the map
 * beside it names the real file.
 */
function enableServerSourcemaps(nuxt: Nuxt): void {
  // Only an explicit choice is respected; `false` here is Nuxt's default
  // rather than a decision, and honouring it would leave every server trace
  // unresolved for no stated reason.
  if (!nuxt.options.sourcemap.server) {
    nuxt.options.sourcemap.server = true
  }

  const nitro = (nuxt.options as {
    nitro?: { experimental?: { sourcemapMinify?: boolean } }
  }).nitro ??= {}

  nitro.experimental ??= {}

  // Left alone when the user has said something, so opting back into smaller
  // maps stays possible — at the cost of unresolved server traces.
  nitro.experimental.sourcemapMinify ??= false
}

/**
 * `sourcemap.client` resolves to `dev` by default, so a production build emits
 * no client maps at all and every browser stack trace would stay minified.
 * `'hidden'` generates them without leaving a `sourceMappingURL` comment
 * behind, which is what lets us read them without pointing browsers at them.
 */
function enableClientSourcemaps(nuxt: Nuxt): void {
  const configured = (nuxt.options as { _monitorUserSourcemap?: unknown })._monitorUserSourcemap
    ?? nuxt.options.sourcemap.client

  if (configured === false || configured === undefined) {
    nuxt.options.sourcemap.client = 'hidden'
    return
  }

  // An explicit `true` means the user wants references in the bundle. Their
  // call, but it publishes the maps, so say so once.
  if (configured === true && !nuxt.options.dev) {
    logger.warn(
      '`sourcemap.client: true` publishes sourcemaps to anyone who requests them. '
      + 'Use `\'hidden\'` to keep them readable by nuxt-monitor but not by the public.',
    )
  }
}

/**
 * `'hidden'` only drops the `sourceMappingURL` comment — the `.map` files are
 * still written into the public directory, where Nitro serves them to anyone
 * who guesses the name. Move them somewhere private and read from there.
 */
function relocateClientSourcemaps(nuxt: Nuxt, archive: ArchiveOptions): void {
  // `nitro:init` is declared by Nuxt at runtime but is absent from the shipped
  // type declarations, so the key is not among the known hook names. The hook
  // exists and fires; the cast only restores the signature.
  const hookNitroInit = nuxt.hook as unknown as (
    name: 'nitro:init',
    fn: (nitro: Nitro) => void,
  ) => void

  let mapsDir = ''

  hookNitroInit('nitro:init', (nitro) => {
    const monitorConfig = nitro.options.runtimeConfig.monitor as Record<string, unknown>

    // Set in dev too, and this is not pointless there.
    //
    // A dev server reads the same database as the production build beside it,
    // so the issues on the dashboard are frequently *not* from the process
    // showing them: they were recorded by `nuxt build && node .output/...`,
    // and their frames name hashed assets Vite has never heard of. Fetching
    // one back from the dev server returns a 404 and the frame reports
    // "no sourcemap covered this frame" — while the map for it is sitting on
    // disk, one directory away.
    monitorConfig.archiveDir = archive.dir

    if (nitro.options.dev) {
      return
    }

    mapsDir = join(nitro.options.output.dir, 'monitor', 'maps')

    // The resolver needs these at request time, and only Nitro knows them.
    monitorConfig.mapsDir = mapsDir
    monitorConfig.serverDir = nitro.options.output.serverDir
  })

  /**
   * Moved after the public directory is populated but before the bundle is
   * built.
   *
   * Nitro builds its public-asset manifest by globbing that directory while
   * rollup runs. Relocating the maps afterwards leaves them listed but absent,
   * so requesting one fails with ENOENT — a 500 that both confirms the file
   * once existed and surfaces as an unhandled error. Removing them first means
   * the manifest never knew about them and the route is a plain 404.
   *
   * `nitro:build:public-assets` is fired by Nuxt immediately after its own
   * `copyPublicAssets` call, which is exactly that window.
   */
  const hookPublicAssets = nuxt.hook as unknown as (
    name: 'nitro:build:public-assets',
    fn: (nitro: Nitro) => Promise<void>,
  ) => void

  hookPublicAssets('nitro:build:public-assets', async (nitro) => {
    const publicDir = nitro.options.output.publicDir

    if (nitro.options.dev || !mapsDir || !existsSync(publicDir)) {
      return
    }

    const moved = await moveMaps(publicDir, mapsDir)

    if (moved > 0) {
      logger.info(`Moved ${moved} sourcemap${moved === 1 ? '' : 's'} out of the public directory.`)
    }

    await archiveMaps(mapsDir, archive)
  })
}

/** Where this build's maps are kept for later, and how many builds are kept. */
interface ArchiveOptions {
  dir: string
  release: string
  keep: number
}

/**
 * Keeps a copy of this build's maps.
 *
 * A deploy replaces the whole output directory, so the maps that explain
 * yesterday's traces are gone the moment they become most interesting: after a
 * release, when the errors arriving are from the version being replaced and
 * from the one replacing it at the same time. The archive lives beside the
 * database rather than in `.output` for exactly that reason — it has to
 * outlive a build.
 *
 * Filed under a *build* id rather than the release. A release name does not
 * identify a build: `dev` is reused on every rebuild, and a tag gets rebuilt
 * after a failed deploy. Keying by release meant the second build deleted the
 * first one's maps, and every event already recorded against it lost its
 * source for good — which is precisely the failure the archive exists to
 * prevent, made quiet by the two directories having the same name.
 *
 * Silent on failure. A missed archive costs resolution of old traces; a throw
 * here would fail the build itself, which is a far worse trade for a
 * monitoring module to make.
 */
async function archiveMaps(mapsDir: string, archive: ArchiveOptions): Promise<void> {
  if (archive.keep <= 0) {
    return
  }

  const build = await buildId(mapsDir)

  // No maps, nothing to file.
  if (!build) {
    return
  }

  const target = join(archive.dir, build)

  try {
    // Skipped when it already exists: the id is derived from the maps
    // themselves, so a directory under this name already holds these exact
    // files. Rewriting it would only reset its modification time and make
    // pruning drop the wrong build.
    if (!existsSync(target)) {
      await mkdir(dirname(target), { recursive: true })
      await cp(mapsDir, target, { recursive: true })
    }

    const dropped = await pruneArchive(archive)

    logger.info(
      `Archived sourcemaps for build ${build}`
      + `${archive.release ? ` (release ${archive.release})` : ''}`
      + `${dropped > 0 ? `, dropped ${dropped} older build${dropped === 1 ? '' : 's'}` : ''}.`,
    )
  }
  catch (error) {
    logger.warn(`Could not archive sourcemaps; traces from older builds may not resolve. ${error}`)
  }
}

/**
 * An identifier for the set of maps a build produced.
 *
 * Derived from the asset names, which already carry a content hash — two
 * builds that differ in any bundled byte produce different names, and two that
 * do not are interchangeable. Measured on real output: consecutive builds of
 * the example share none of their fourteen asset names.
 *
 * That property is also what makes a frame findable later. A frame carries an
 * asset name and nothing else, so the name has to be enough to identify which
 * build it came from — and it is.
 */
async function buildId(mapsDir: string): Promise<string> {
  const names: string[] = []

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(full)
      }
      else if (entry.name.endsWith('.map')) {
        names.push(relative(mapsDir, full))
      }
    }
  }

  try {
    await walk(mapsDir)
  }
  catch {
    return ''
  }

  if (names.length === 0) {
    return ''
  }

  // Sorted, so the id does not depend on the order the filesystem lists them.
  return createHash('sha256').update(names.sort().join('\n')).digest('hex').slice(0, 12)
}

/**
 * Drops the oldest archived releases past `keep`.
 *
 * Maps are large and a deploy happens far more often than a cleanup would, so
 * without this the archive is a directory that only ever grows — on the same
 * disk as the database it sits next to. Ordered by modification time, so the
 * releases kept are the ones most recently built.
 */
async function pruneArchive(archive: ArchiveOptions): Promise<number> {
  const entries = await readdir(archive.dir, { withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory())

  if (directories.length <= archive.keep) {
    return 0
  }

  const dated = await Promise.all(directories.map(async (entry) => {
    const path = join(archive.dir, entry.name)
    const info = await stat(path)

    return { path, at: info.mtimeMs }
  }))

  const stale = dated.sort((a, b) => b.at - a.at).slice(archive.keep)

  for (const entry of stale) {
    await rm(entry.path, { recursive: true, force: true })
  }

  return stale.length
}

/** Moves every `*.map` under `from` into `to`, preserving relative layout. */
async function moveMaps(from: string, to: string): Promise<number> {
  let moved = 0

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(full)
        continue
      }

      if (!entry.name.endsWith('.map')) {
        continue
      }

      const target = join(to, relative(from, full))
      await mkdir(dirname(target), { recursive: true })
      await rename(full, target)
      moved++
    }
  }

  await walk(from)
  await rm(join(from, '_nuxt', 'builds', 'meta'), { recursive: true, force: true }).catch(() => {})

  return moved
}

/**
 * The prebuilt SPA ships as a *server* asset, not a public one: `publicAssets`
 * copies files into `.output/public` where static middleware serves them ahead
 * of any handler, which would put the dashboard on the open internet. As a
 * server asset it is only reachable through our handler, after the session
 * check has run.
 */
function registerDashboard(
  nuxt: Nuxt,
  resolver: ReturnType<typeof createResolver>,
  route: string,
): void {
  const clientDir = resolver.resolve('./client')

  // Same reason as `nitro:init` above: the `nitro` key is contributed by
  // nitropack's augmentation, which the shipped Nuxt declarations do not carry.
  const nitroOptions = (nuxt.options as { nitro?: { serverAssets?: { baseName: string, dir: string }[] } }).nitro ??= {}

  nitroOptions.serverAssets ||= []
  nitroOptions.serverAssets.push({
    baseName: 'monitor-client',
    dir: clientDir,
  })

  for (const path of ['login', 'logout', 'session'] as const) {
    addServerHandler({
      route: `${route}/api/${path}`,
      method: 'post',
      handler: resolver.resolve(`./runtime/server/routes/${path}`),
    })
  }

  addServerHandler({
    route: `${route}/api/overview`,
    method: 'get',
    handler: resolver.resolve('./runtime/server/routes/overview'),
  })

  addServerHandler({
    route: `${route}/api/issues`,
    method: 'get',
    handler: resolver.resolve('./runtime/server/routes/issues'),
  })

  addServerHandler({
    route: `${route}/api/facets`,
    method: 'get',
    handler: resolver.resolve('./runtime/server/routes/facets'),
  })

  addServerHandler({
    route: `${route}/api/stats`,
    method: 'get',
    handler: resolver.resolve('./runtime/server/routes/stats'),
  })

  addServerHandler({
    route: `${route}/api/health`,
    method: 'get',
    handler: resolver.resolve('./runtime/server/routes/health'),
  })

  // Both methods on one handler: `GET` reads the log, `POST` sends a test.
  addServerHandler({
    route: `${route}/api/notifications`,
    handler: resolver.resolve('./runtime/server/routes/notifications'),
  })

  addServerHandler({
    route: `${route}/api/dashboard`,
    method: 'get',
    handler: resolver.resolve('./runtime/server/routes/dashboard'),
  })

  addServerHandler({
    route: `${route}/api/uptime`,
    method: 'get',
    handler: resolver.resolve('./runtime/server/routes/uptime'),
  })

  addServerHandler({
    route: `${route}/api/export`,
    method: 'get',
    handler: resolver.resolve('./runtime/server/routes/export'),
  })

  addServerHandler({
    route: `${route}/api/issues/:fingerprint`,
    handler: resolver.resolve('./runtime/server/routes/issue'),
  })

  // Catch-all last: it serves the SPA shell for every remaining path.
  // Both forms are needed — `/_monitor/**` does not match the bare `/_monitor`,
  // which is the URL people actually type.
  for (const pattern of [route, `${route}/**`]) {
    addServerHandler({
      route: pattern,
      handler: resolver.resolve('./runtime/server/routes/ui'),
    })
  }
}
