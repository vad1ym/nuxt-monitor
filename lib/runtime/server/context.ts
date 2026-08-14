import type { H3Event } from 'h3'
import { createError, useRuntimeConfig } from '#imports'
import type {
  MonitorCaptureOptions,
  MonitorEvent,
  MonitorIgnoreOptions,
  MonitorGroupOptions,
  MonitorNotificationOptions,
  MonitorSamplingOptions,
  MonitorSide,
} from '../../types'
import type { ParsedUserAgent } from '../shared/user-agent'
import { DisabledStore } from './disabled-store'
import { MonitorStore } from './store'
import type { ResolvedAuth } from './session'
import { hasValidSession, resolveAuth } from './session'

export interface MonitorRuntimeConfig {
  route: string
  storageDir: string
  /** Connection string for an external database. Empty means SQLite. */
  databaseUrl: string
  /** Empty when unset — `runtimeConfig` serializes absent values as ''. */
  release: string
  /** What the bundle was built with. Node's own version is read at runtime. */
  versions: { nuxt?: string, nitro?: string }
  retentionDays: number
  maxEventsPerIssue: number
  maxIssues: number
  maxDatabaseMb: number
  scrubKeys: string[]
  capture: MonitorCaptureOptions
  ignore: MonitorIgnoreOptions
  notifications: MonitorNotificationOptions
  sampling: MonitorSamplingOptions
  groups: MonitorGroupOptions
  baseURL: string
  cdnURL: string
  mapsDir: string
  serverDir: string
  /** Root of the per-release sourcemap archive. Empty when nothing is kept. */
  archiveDir: string
  auth: {
    username?: string
    password?: string
    passwordHash?: string
    secret?: string
    sessionTtl?: number
    /** Resolved at build time; always `false` in a production build. */
    optional?: boolean
  }
}

export function monitorConfig(): MonitorRuntimeConfig {
  return (useRuntimeConfig() as unknown as { monitor: MonitorRuntimeConfig }).monitor
}

/**
 * Process-wide store.
 *
 * One SQLite connection per process, opened on first use: collection has to
 * work whether or not anyone ever opens the dashboard.
 */
let store: MonitorCollector | undefined

/**
 * Either a working store or the one that quietly does nothing.
 *
 * The dashboard and the collectors both take this type, so neither has to know
 * which it got.
 */
export type MonitorCollector = MonitorStore | DisabledStore

/**
 * The store, once it is open.
 *
 * Held separately from `store` so `captureSync` can tell "not opened yet" from
 * "opened and unusable" without awaiting anything.
 */
let opening: Promise<MonitorCollector> | undefined

export async function useMonitorStore(): Promise<MonitorCollector> {
  if (store) {
    return store
  }

  // Opening is asynchronous now, and several requests can arrive during it.
  // Without this they would each open their own database — several connections
  // to one SQLite file, each with its own buffer and its own timers.
  opening ??= openStore()
  store = await opening

  return store
}

async function openStore(): Promise<MonitorCollector> {
  const config = monitorConfig()

  try {
    return await MonitorStore.open({
      dir: config.storageDir,
      url: config.databaseUrl || undefined,
      retentionDays: config.retentionDays,
      maxEventsPerIssue: config.maxEventsPerIssue,
      maxIssues: config.maxIssues,
      // Megabytes at the surface, bytes inside: the option is a human number
      // and the store compares against a page count.
      maxBytes: Math.max(0, config.maxDatabaseMb) * 1_024 * 1_024,
      ignore: config.ignore,
      notifications: config.notifications,
      sampling: config.sampling,
      groups: config.groups,
    })
  }
  catch (error) {
    // Opening the database is the one thing here that touches the filesystem,
    // and it runs while the Nitro plugin is being registered — outside any
    // request, outside any handler's try/catch. A read-only volume or a full
    // disk therefore stopped the application from booting at all. Collection
    // is not worth that: turn it off and let the app serve traffic.
    const reason = error instanceof Error ? error.message : String(error)

    console.error(
      `[monitor] could not open the database at ${config.databaseUrl || config.storageDir}, so error `
      + `collection is disabled for this process. The application is unaffected. ${reason}`,
    )

    return new DisabledStore(reason)
  }
}

/**
 * Captures without waiting for the database to be ready.
 *
 * The server collector runs inside Nitro's `error` hook and the browser
 * collector inside a request handler; neither may hold a response open while a
 * connection is established. Once the store is open this is a synchronous
 * buffer push exactly as before — only the very first errors of a process
 * reach the queue below.
 */
const pending: MonitorEvent[] = []

/** Bounded, in case the database never opens at all. */
const MAX_PENDING_BEFORE_OPEN = 100

export function captureSync(event: MonitorEvent): void {
  if (store) {
    store.capture(event)
    return
  }

  if (pending.length < MAX_PENDING_BEFORE_OPEN) {
    pending.push(event)
  }

  void useMonitorStore().then((ready) => {
    // Drained in arrival order, and only once: `pending` is emptied by the
    // first opener, so a second caller finds nothing to replay.
    for (const queued of pending.splice(0)) {
      ready.capture(queued)
    }
  })
}

/** Requests counted before the database finished opening. */
const pendingCounts: [route: string, method: string, status: number][] = []

/**
 * Counts a request without waiting, for the same reason as `captureSync`.
 *
 * Queued rather than dropped while the store opens. Dropping looked harmless —
 * a counter is only a denominator — but opening is a network round trip
 * against an external database, and *every* request the application serves in
 * that window arrives here. On a quiet app that is all of them, and an error
 * rate computed against a denominator of zero reports no data rather than the
 * failure it was asked about.
 */
export function countRequestSync(route: string, method: string, status: number): void {
  if (store) {
    store.countRequest(route, method, status)
    return
  }

  if (pendingCounts.length < MAX_PENDING_BEFORE_OPEN) {
    pendingCounts.push([route, method, status])
  }

  void useMonitorStore().then((ready) => {
    for (const [path, verb, code] of pendingCounts.splice(0)) {
      ready.countRequest(path, verb, code)
    }
  })
}

/** Page views counted before the database finished opening. */
const pendingTraffic: ParsedUserAgent[] = []

/**
 * Counts one page view's browser and device, without waiting.
 *
 * Queued rather than dropped while the store opens, for the same reason
 * request counts are: on a quiet application the requests served during that
 * window are all of them, and a baseline missing its first minutes would
 * understate exactly the audience a breakdown is compared against.
 */
export function countTrafficSync(agent: ParsedUserAgent): void {
  if (store) {
    store.countTraffic(agent)
    return
  }

  if (pendingTraffic.length < MAX_PENDING_BEFORE_OPEN) {
    pendingTraffic.push(agent)
  }

  void useMonitorStore().then((ready) => {
    for (const queued of pendingTraffic.splice(0)) {
      ready.countTraffic(queued)
    }
  })
}

/** Whether collection is actually running, for the health endpoint. */
export async function isCollectionEnabled(): Promise<boolean> {
  return !(await useMonitorStore() instanceof DisabledStore)
}

/** Exposed for tests and for a clean shutdown. */
export async function closeMonitorStore(): Promise<void> {
  await store?.close()
  store = undefined
  opening = undefined
}

let auth: ResolvedAuth | undefined | null = null

/** Hashing the configured password is expensive, so do it once. */
export function useMonitorAuth(): ResolvedAuth | undefined {
  if (auth === null) {
    auth = resolveAuth(monitorConfig().auth)
  }

  return auth
}

/**
 * Gate for every dashboard route.
 *
 * Without credentials configured the dashboard does not exist as far as the
 * network is concerned: 404 rather than 403, since a 403 would confirm there
 * is something here worth attacking.
 */
export function requireDashboardAccess(event: H3Event): void {
  const resolved = useMonitorAuth()

  if (!resolved) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  // Development only, and resolved into the build rather than read from the
  // environment — a production artefact never reaches this branch.
  if (resolved.optional) {
    return
  }

  if (!hasValidSession(event, resolved)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}

export function parseSide(value: unknown): MonitorSide | undefined {
  return value === 'client' || value === 'server' ? value : undefined
}
