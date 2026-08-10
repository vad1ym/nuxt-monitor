import type { H3Event } from 'h3'
import { createError, useRuntimeConfig } from '#imports'
import type { MonitorIgnoreOptions, MonitorSide } from '../../types'
import { DisabledStore } from './disabled-store'
import { MonitorStore } from './store'
import type { ResolvedAuth } from './session'
import { hasValidSession, resolveAuth } from './session'

export interface MonitorRuntimeConfig {
  route: string
  storageDir: string
  /** Empty when unset — `runtimeConfig` serializes absent values as ''. */
  release: string
  retentionDays: number
  maxEventsPerIssue: number
  maxIssues: number
  maxDatabaseMb: number
  scrubKeys: string[]
  ignore: MonitorIgnoreOptions
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

export function useMonitorStore(): MonitorCollector {
  if (store) {
    return store
  }

  const config = monitorConfig()

  try {
    store = new MonitorStore({
      dir: config.storageDir,
      retentionDays: config.retentionDays,
      maxEventsPerIssue: config.maxEventsPerIssue,
      maxIssues: config.maxIssues,
      // Megabytes at the surface, bytes inside: the option is a human number
      // and the store compares against a page count.
      maxBytes: Math.max(0, config.maxDatabaseMb) * 1_024 * 1_024,
      ignore: config.ignore,
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
      `[monitor] could not open the database at ${config.storageDir}, so error `
      + `collection is disabled for this process. The application is unaffected. ${reason}`,
    )

    store = new DisabledStore(reason)
  }

  return store
}

/** Whether collection is actually running, for the health endpoint. */
export function isCollectionEnabled(): boolean {
  return !(useMonitorStore() instanceof DisabledStore)
}

/** Exposed for tests and for a clean shutdown. */
export function closeMonitorStore(): void {
  store?.close()
  store = undefined
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

  if (!hasValidSession(event, resolved)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}

export function parseSide(value: unknown): MonitorSide | undefined {
  return value === 'client' || value === 'server' ? value : undefined
}
