import type {
  MonitorDelivery,
  MonitorDeploy,
  MonitorEvent,
  MonitorFacetCounts,
  MonitorHealth,
  MonitorIssue,
  MonitorIssueTrend,
  MonitorOverview,
  MonitorRelease,
  MonitorRouteStat,
  MonitorSessionStats,
  MonitorUptimeSummary,
  MonitorDashboard,
} from '../../types'
import type { ExportOptions } from './export'
import { csvHeader } from './export'
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
  'capture' | 'countRequest' | 'countTraffic' | 'flush' | 'close' | 'listIssues' | 'getIssue'
  | 'getEvents' | 'facetCounts' | 'sessionCount' | 'eventCount' | 'overview'
  | 'setResolved' | 'setIgnored' | 'purge' | 'releases' | 'routes' | 'sessions' | 'health'
  | 'deliveries' | 'alerts' | 'exportRows' | 'uptime' | 'dashboard'
> {
  /** Why collection is off, for the health endpoint and the dashboard. */
  constructor(readonly reason: string) {}

  capture(): string {
    return ''
  }

  countRequest(): void {}

  countTraffic(): void {}

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  async purge(): Promise<{ events: number, issues: number }> {
    return { events: 0, issues: 0 }
  }

  async listIssues(): Promise<{ issues: MonitorIssue[], total: number }> {
    return { issues: [], total: 0 }
  }

  async getIssue(): Promise<MonitorIssue | undefined> {
    return undefined
  }

  async getEvents(): Promise<MonitorEvent[]> {
    return []
  }

  async facetCounts(): Promise<MonitorFacetCounts> {
    // Every dimension present and empty, so the dashboard renders "nothing to
    // filter by" rather than failing on a missing key.
    const counts = {} as MonitorFacetCounts

    for (const name of FACET_NAMES) {
      counts[name] = { values: [], more: false }
    }

    return counts
  }

  async sessionCount(): Promise<number> {
    return 0
  }

  async eventCount(): Promise<number> {
    return 0
  }

  async issueTrend(): Promise<MonitorIssueTrend> {
    return { points: [], stored: 0, step: 0 }
  }

  async issueReleases(): Promise<undefined> {
    return undefined
  }

  async deploysBetween(): Promise<MonitorDeploy[]> {
    return []
  }

  async overview(windowMs = 24 * 60 * 60 * 1_000): Promise<MonitorOverview> {
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
      affectedSessions: 0,
      trend: [],
      topRoutes: [],
      recent: [],
    }
  }

  async releases(): Promise<MonitorRelease[]> {
    return []
  }

  async routes(): Promise<MonitorRouteStat[]> {
    return []
  }

  async sessions(): Promise<MonitorSessionStats> {
    return { affected: 0, events: 0, worst: [] }
  }

  async setResolved(): Promise<boolean> {
    return false
  }

  async setIgnored(): Promise<boolean> {
    return false
  }

  /**
   * No log, because no database to have written one.
   *
   * Alerting is not separately disabled here — it never ran. The triggers are
   * evaluated from the issue rows a flush wrote, and nothing was flushed.
   */
  async deliveries(): Promise<MonitorDelivery[]> {
    return []
  }

  /** An empty screen rather than a failing one. */
  async dashboard(): Promise<MonitorDashboard> {
    return {
      windowMs: 0,
      totals: { requests: 0, failed: 0, events: 0, issues: 0, newIssues: 0, affectedSessions: 0 },
      trend: [],
      breakdowns: [],
      routes: [],
      recent: [],
      deploys: [],
    }
  }

  /** Nothing recorded, so nothing is claimed about any day. */
  async uptime(): Promise<MonitorUptimeSummary> {
    return { days: [], newIssues: 0, calmDays: 0, measuredDays: 0 }
  }

  /** Nothing to send through; the dashboard reads this to say alerting is off. */
  get alerts(): undefined {
    return undefined
  }

  /**
   * A well-formed empty export.
   *
   * An empty file rather than an error: the caller asked for the data there
   * is, and there is none. A download that fails would read as "export is
   * broken" when the truth is that collection never started.
   */
  async* exportRows(options: ExportOptions): AsyncGenerator<string> {
    yield options.format === 'csv' ? csvHeader(options.table) : '[\n\n]\n'
  }

  /**
   * The one call whose answer differs from "empty".
   *
   * Every other method here returns nothing because there is nothing; this one
   * has to say *why*, or a dashboard showing no errors is indistinguishable
   * from an application having none.
   */
  async health(): Promise<MonitorHealth> {
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
      // Nothing is being admitted, let alone sampled.
      sampling: false,
      sampled: 0,
    }
  }
}
