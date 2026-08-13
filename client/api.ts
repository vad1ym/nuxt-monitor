import type {
  MonitorDelivery,
  MonitorEvent,
  MonitorFacetCounts,
  MonitorFacetFilter,
  MonitorFrame,
  MonitorHealth,
  MonitorIssue,
  MonitorIssueTrend,
  MonitorOverview,
  MonitorQuietHours,
  MonitorRelease,
  MonitorRouteStat,
  MonitorSessionStats,
  MonitorTrafficStats,
  MonitorTriggerOptions,
} from '../lib/types'

/**
 * The dashboard route is configurable, and the SPA is built once with no
 * knowledge of it. Deriving the base from the current URL keeps the bundle
 * mount-point agnostic.
 */
function apiBase(): string {
  const path = window.location.pathname
  const marker = '/api/'
  const index = path.indexOf(marker)

  if (index !== -1) {
    return `${path.slice(0, index)}/api`
  }

  // Strip any SPA sub-route to get back to the mount point.
  return `${path.replace(/\/issues\/[^/]*\/?$/, '').replace(/\/+$/, '')}/api`
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
    // The session cookie is scoped to the dashboard route.
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response))
  }

  if (response.status === 204) {
    return null as T
  }

  try {
    return await response.json() as T
  }
  catch {
    /**
     * A 200 that is not JSON means the request fell through to the SPA
     * catch-all — the handler for this path is not registered in the running
     * server. That happens to a dev server started before the route existed,
     * and `Unexpected token '<'` is a uselessly cryptic way to say so.
     */
    throw new ApiError(response.status, `${path} did not return JSON. `
      + 'If the server has been running since before this endpoint was added, restart it.')
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { statusMessage?: string, message?: string }

    return body.statusMessage ?? body.message ?? response.statusText
  }
  catch {
    return response.statusText
  }
}

/**
 * What the notifications screen renders.
 *
 * Channels arrive as names and types only — the server never sends a token, and
 * this type is the reminder of why: anything here is in a browser's memory and
 * in whatever later reads it.
 */
export interface NotificationSettings {
  /** False when nothing is configured, which is the default. */
  enabled: boolean
  /** `usable` is false when no token or URL resolved for a declared channel. */
  channels: { name: string, type: string, enabled: boolean, usable: boolean }[]
  triggers: MonitorTriggerOptions
  cooldownMinutes: number
  groupWindowSeconds: number
  quietHours?: MonitorQuietHours
  deliveries: MonitorDelivery[]
}

export interface IssueDetail {
  issue: MonitorIssue
  events: (MonitorEvent & { frames: MonitorFrame[] })[]
  facets: MonitorFacetCounts
  /** Distinct sessions behind the occurrences. 0 for server-side issues. */
  sessionCount: number
  /** Stored occurrences matching the filter — what the facets add up to. */
  eventCount: number
  /** When those occurrences happened, bucketed for the chart. */
  trend: MonitorIssueTrend
}

/** Turns a facet filter into repeated query parameters. */
function appendFacets(query: URLSearchParams, filter: MonitorFacetFilter = {}): void {
  for (const [name, values] of Object.entries(filter)) {
    for (const value of values ?? []) {
      query.append(name, value)
    }
  }
}

export const api = {
  session: () => request<{ authenticated: boolean }>('/session', { method: 'POST' }),

  login: (username: string, password: string) =>
    request<{ ok: true }>('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: true }>('/logout', { method: 'POST' }),

  overview: (hours = 24) => request<MonitorOverview>(`/overview?hours=${hours}`),

  issues: (params: {
    side?: string
    resolved?: boolean
    ignored?: boolean
    /** True keeps only `exception()` reports; false only caught errors. */
    manual?: boolean
    group?: string
    level?: string
    /** `api`, `page` or `asset`. */
    kind?: string
    sort?: string
    search?: string
    type?: string
    limit?: number
    offset?: number
  } = {}, filter?: MonitorFacetFilter) => {
    const query = new URLSearchParams()

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        query.set(key, String(value))
      }
    }

    appendFacets(query, filter)

    const suffix = query.toString()

    return request<{ issues: MonitorIssue[], total: number }>(`/issues${suffix ? `?${suffix}` : ''}`)
  },

  issue: (fingerprint: string, filter?: MonitorFacetFilter, facetLimit?: number) => {
    const query = new URLSearchParams()
    appendFacets(query, filter)

    if (facetLimit) {
      query.set('limit', String(facetLimit))
    }

    const suffix = query.toString()

    return request<IssueDetail>(
      `/issues/${encodeURIComponent(fingerprint)}${suffix ? `?${suffix}` : ''}`,
    )
  },

  facets: (filter?: MonitorFacetFilter, hours = 24, facetLimit?: number) => {
    const query = new URLSearchParams({ window: String(hours * 60 * 60 * 1_000) })
    appendFacets(query, filter)

    if (facetLimit) {
      query.set('limit', String(facetLimit))
    }

    return request<{ windowMs: number, facets: MonitorFacetCounts }>(`/facets?${query}`)
  },

  /**
   * Releases, routes, environments and sessions.
   *
   * `section` fetches just one; the sections are separate screens but share an
   * endpoint so their numbers always describe the same window.
   */
  stats: (section?: 'releases' | 'routes' | 'sessions' | 'environments' | 'traffic', hours = 24) => {
    const query = new URLSearchParams({ window: String(hours * 60 * 60 * 1_000) })

    if (section) {
      query.set('section', section)
    }

    return request<{
      windowMs: number
      releases?: MonitorRelease[]
      routes?: MonitorRouteStat[]
      sessions?: MonitorSessionStats
      environments?: MonitorFacetCounts
      traffic?: MonitorTrafficStats
    }>(`/stats?${query}`)
  },

  /** The collector's own state — see `HealthBanner`. */
  health: () => request<MonitorHealth & { release?: string, storageDir: string }>('/health'),

  notifications: (limit = 100) =>
    request<NotificationSettings>(`/notifications?limit=${limit}`),

  /**
   * Sends a test alert to every configured channel.
   *
   * The one write on this screen, and the reason the screen justifies itself: a
   * token and a chat id are copied by hand, and the alternative way to find out
   * they are wrong is the first real incident going unreported.
   */
  testNotification: () =>
    request<{ sent: boolean, reason?: string, deliveries?: MonitorDelivery[] }>(
      '/notifications',
      { method: 'POST' },
    ),

  setResolved: (fingerprint: string, resolved: boolean) =>
    request<MonitorIssue>(`/issues/${encodeURIComponent(fingerprint)}`, {
      method: 'PATCH',
      body: JSON.stringify({ resolved }),
    }),

  /** Puts an issue aside as not the application's problem — see `setResolved`. */
  setIgnored: (fingerprint: string, ignored: boolean) =>
    request<MonitorIssue>(`/issues/${encodeURIComponent(fingerprint)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ignored }),
    }),
}
