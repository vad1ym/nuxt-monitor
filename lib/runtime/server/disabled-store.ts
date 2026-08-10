import type {
  MonitorEvent,
  MonitorFacetCounts,
  MonitorHealth,
  MonitorIssue,
  MonitorOverview,
  MonitorRelease,
  MonitorRouteStat,
  MonitorSessionStats,
} from '../../types'
import { FACET_NAMES } from './facets'
import type { MonitorStore } from './store'

/**
 * The store that answers when there is no database.
 *
 * Opening SQLite can fail for reasons that have nothing to do with the
 * application: a read-only filesystem, a full disk, a container image where
 * the storage directory is not writable. The failure surfaced at import of the
 * Nitro plugin, outside any handler, so a monitoring module took down the
 * application it exists to watch — the single worst thing it can do.
 *
 * Rather than teach every call site to expect `undefined`, a failed open swaps
 * in this: collection silently stops, the dashboard shows an empty database,
 * and the application serves traffic. Losing error reports is a bad day;
 * refusing to boot is an outage.
 */
export class DisabledStore implements Pick<
  MonitorStore,
  'capture' | 'countRequest' | 'flush' | 'close' | 'listIssues' | 'getIssue'
  | 'getEvents' | 'facetCounts' | 'sessionCount' | 'eventCount' | 'overview'
  | 'setResolved' | 'purge' | 'releases' | 'routes' | 'sessions' | 'health'
> {
  /** Why collection is off, for the health endpoint and the dashboard. */
  constructor(readonly reason: string) {}

  capture(): string {
    return ''
  }

  countRequest(): void {}

  flush(): void {}

  close(): void {}

  purge(): { events: number, issues: number } {
    return { events: 0, issues: 0 }
  }

  listIssues(): { issues: MonitorIssue[], total: number } {
    return { issues: [], total: 0 }
  }

  getIssue(): MonitorIssue | undefined {
    return undefined
  }

  getEvents(): MonitorEvent[] {
    return []
  }

  facetCounts(): MonitorFacetCounts {
    // Every dimension present and empty, so the dashboard renders "nothing to
    // filter by" rather than failing on a missing key.
    const counts = {} as MonitorFacetCounts

    for (const name of FACET_NAMES) {
      counts[name] = []
    }

    return counts
  }

  sessionCount(): number {
    return 0
  }

  eventCount(): number {
    return 0
  }

  overview(windowMs = 24 * 60 * 60 * 1_000): MonitorOverview {
    return {
      windowMs,
      serverErrors: 0,
      clientErrors: 0,
      totalEvents: 0,
      issueCount: 0,
      unresolvedCount: 0,
      requestCount: 0,
      failedRequestCount: 0,
      // Undefined, not zero: nothing was measured, and "0% errors" would be a
      // reassuring lie from a module that is not collecting anything.
      errorRate: undefined,
      trend: [],
      topRoutes: [],
      recent: [],
    }
  }

  releases(): MonitorRelease[] {
    return []
  }

  routes(): MonitorRouteStat[] {
    return []
  }

  sessions(): MonitorSessionStats {
    return { affected: 0, events: 0, worst: [] }
  }

  setResolved(): boolean {
    return false
  }

  /**
   * The one call whose answer differs from "empty".
   *
   * Every other method here returns nothing because there is nothing; this one
   * has to say *why*, or a dashboard showing no errors is indistinguishable
   * from an application having none.
   */
  health(): MonitorHealth {
    return {
      enabled: false,
      reason: this.reason,
      bytes: 0,
      maxBytes: 0,
      overCeiling: false,
      pending: 0,
      pendingCounters: 0,
      dropped: 0,
      retryAfter: 0,
      issues: 0,
      events: 0,
      retentionDays: 0,
      maxIssues: 0,
    }
  }
}
