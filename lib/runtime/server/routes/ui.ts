import {
  createError,
  defineEventHandler,
  getRequestHeader,
  send,
  setResponseHeader,
  setResponseStatus,
  useStorage,
} from '#imports'
import { monitorConfig, useMonitorAuth } from '../context'

/**
 * Serves the prebuilt dashboard.
 *
 * The assets are a Nitro *server* asset rather than a public one, so they are
 * only reachable through this handler — which means the session check below
 * actually gates them. Registering them as public assets would have Nitro's
 * static middleware serve them ahead of any handler, with no check at all.
 */
export default defineEventHandler(async (event) => {
  const config = monitorConfig()
  const auth = useMonitorAuth()

  if (!auth) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  const requestPath = (event.path ?? '').split('?')[0] ?? ''

  // The shell references its assets relatively (`./assets/…`) so the bundle
  // works at any mount point. Without a trailing slash the browser resolves
  // those against the parent directory and asks for `/assets/…`, which is not
  // ours — so the bare path is served with a `<base>` naming the mount point
  // instead.
  //
  // A 302 to the slashed form used to do this, and it was a trap: an
  // application that canonicalises URLs by *stripping* trailing slashes — a
  // common SEO rule, and one that usually runs in a Nitro `request` hook ahead
  // of every route — answers that redirect with one of its own, and the two
  // bounce until the browser gives up with ERR_TOO_MANY_REDIRECTS. Serving
  // both forms directly means there is no redirect left to fight with.
  if (requestPath === config.route) {
    return sendShell(event, useStorage('assets:monitor-client'), config.route)
  }

  const path = assetPath(event.path ?? '', config.route)
  const isShell = path === 'index.html'

  // The shell and its assets are served unauthenticated, because the login
  // screen *is* the SPA and cannot render without them. They are inert build
  // artefacts: every byte of captured data comes from the API, which requires
  // a session on each route.
  const storage = useStorage('assets:monitor-client')
  const meta = await storage.getMeta(path).catch(() => null) as
    { type?: string, etag?: string, mtime?: string } | null

  const raw = await storage.getItemRaw(path).catch(() => null)

  if (raw === null || raw === undefined) {
    // Unknown path inside the dashboard: hand back the shell and let the SPA
    // router decide, which is what makes deep links work.
    return isShell
      ? notFound()
      : sendShell(event, storage)
  }

  // Nitro precomputes the etag when it bundles the asset, so conditional
  // requests cost nothing to support.
  if (meta?.etag) {
    setResponseHeader(event, 'etag', meta.etag)

    if (getRequestHeader(event, 'if-none-match') === meta.etag) {
      setResponseStatus(event, 304)
      return send(event, '')
    }
  }

  // Nitro precomputes `type` when it bundles assets for production, but the
  // dev driver reads straight off disk and supplies no meta — so fall back to
  // the extension rather than serving everything as a download.
  setResponseHeader(event, 'content-type', meta?.type || contentType(path))

  // The dashboard must never be cached by a shared proxy: it is per-session
  // and its contents are sensitive.
  setResponseHeader(
    event,
    'cache-control',
    isShell ? 'no-store' : 'private, max-age=31536000, immutable',
  )
  setResponseHeader(event, 'x-content-type-options', 'nosniff')
  setResponseHeader(event, 'referrer-policy', 'no-referrer')

  return send(event, toBuffer(raw))
})

/** Maps a request path to a key inside the asset storage. */
function assetPath(requestPath: string, route: string): string {
  const withoutRoute = requestPath.startsWith(route)
    ? requestPath.slice(route.length)
    : requestPath

  const [pathname] = withoutRoute.split('?')
  const trimmed = (pathname ?? '').replace(/^\/+/, '')

  if (!trimmed || trimmed.endsWith('/')) {
    return 'index.html'
  }

  // A path with no extension is an SPA route, not a file.
  return trimmed.includes('.') ? trimmed : 'index.html'
}

async function sendShell(
  event: Parameters<typeof setResponseHeader>[0],
  storage: ReturnType<typeof useStorage>,
  /**
   * Mount point to anchor relative asset URLs to.
   *
   * Passed only when the request had no trailing slash, which is the one case
   * where `./assets/…` would resolve against the parent directory.
   */
  base?: string,
): Promise<unknown> {
  const shell = await storage.getItemRaw('index.html').catch(() => null)

  if (!shell) {
    return notFound()
  }

  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')

  return send(event, base ? withBase(toBuffer(shell), base) : toBuffer(shell))
}

/**
 * Points the shell's relative URLs at the mount point.
 *
 * Inserted rather than baked in at build time because the mount point is a
 * runtime option: the same bundle serves `/_monitor` and whatever anybody
 * renames it to. Injected right after `<head>` so it precedes the asset tags —
 * a `<base>` after them has no effect on what they already resolved.
 */
function withBase(shell: Buffer, route: string): Buffer {
  const html = shell.toString('utf8')

  // Only when there is a head to put it in. A shell without one is not
  // something to guess at, and serving it unchanged is what happened before.
  if (!html.includes('<head>')) {
    return shell
  }

  return Buffer.from(html.replace('<head>', `<head><base href="${route}/">`), 'utf8')
}

function notFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
}

/**
 * Content types for the handful of extensions the dashboard bundle contains.
 * A full mime database would be a dependency for no benefit here.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
  ico: 'image/x-icon',
}

function contentType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''

  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }

  return Buffer.from(String(value))
}
