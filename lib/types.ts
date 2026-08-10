/**
 * Public option surface. Everything here is user-facing, so the shapes are
 * deliberately plain — they have to survive a round-trip through
 * `runtimeConfig`, which is JSON.
 */

export interface MonitorAuthOptions {
  /** Username for the dashboard login form. */
  username?: string
  /**
   * Plaintext password. Convenient in dev; in production prefer `passwordHash`
   * so the secret is not sitting in the config file or the build output.
   */
  password?: string
  /** `scrypt` hash produced by `npx monitor hash-password`. Wins over `password`. */
  passwordHash?: string
  /**
   * Secret for signing session cookies. When absent it is derived from the
   * password hash, which means changing the password invalidates every
   * outstanding session — the behaviour you want from a password change.
   */
  secret?: string
  /** Session lifetime in seconds. Default: 7 days. */
  sessionTtl?: number
  /**
   * Serve the dashboard without a password. Development only.
   *
   * Defaults to `true` in dev, where an unprotected dashboard on localhost is
   * a convenience rather than an exposure, and setting a password just to read
   * your own errors is friction with nothing behind it.
   *
   * **Ignored in a production build.** Not "defaults to false" — the value is
   * discarded at build time, so `optional: true` committed to a config file
   * cannot open the dashboard once deployed. A monitoring dashboard lists your
   * routes, your stack traces and your source, which is reconnaissance handed
   * over for free; that is not a mistake a config flag should be able to make.
   */
  optional?: boolean
}

export interface MonitorOptions {
  /** Master switch. Default: `true`. */
  enabled?: boolean
  /** Where the dashboard and its API are mounted. Default: `/_monitor`. */
  route?: string
  /** Directory for the SQLite database, relative to the app root. Default: `.monitor`. */
  storageDir?: string
  /** Dashboard credentials. Without a password in production the UI is disabled. */
  auth?: MonitorAuthOptions
  /**
   * Version of the application, recorded on every event.
   *
   * "When did this start?" is the first question during an incident, and a
   * release stamped on each event answers it directly — "appeared in 1.4.0"
   * rather than a timestamp somebody has to match against a deploy log.
   *
   * Read at build time, so a value from `process.env` or `package.json` is
   * baked into the build it describes. Defaults to `NUXT_MONITOR_RELEASE`, and
   * then to the commit SHA CI providers expose (`GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`,
   * `CF_PAGES_COMMIT_SHA`, `COMMIT_REF`).
   */
  release?: string
  /** How long events are kept, in days. Default: 14. */
  retentionDays?: number
  /** Cap on stored events per issue, oldest evicted first. Default: 100. */
  maxEventsPerIssue?: number
  /**
   * Cap on how many distinct issues are kept. Default: 5000.
   *
   * Retention bounds the database by age and `maxEventsPerIssue` bounds it
   * within an issue, but neither bounds the number of issues — and a message
   * carrying text that normalisation cannot strip gives every occurrence its
   * own fingerprint. Without a ceiling the table grows with traffic rather
   * than with the size of the application.
   *
   * Stale and rare issues are evicted first, resolved ones before that.
   */
  maxIssues?: number
  /**
   * Ceiling on how much the database may hold, in megabytes. Default: 256.
   *
   * `retentionDays` bounds by age and `maxIssues` by count, and neither bounds
   * bytes: a hundred events with long stacks behind each of a few thousand
   * issues fills a disk days before the retention window comes round. Since
   * this usually sits on the same disk as the application it watches, that is
   * an outage caused by the tool that exists to catch outages.
   *
   * Oldest events are evicted first. Set to `0` for no ceiling.
   */
  maxDatabaseMb?: number
  /**
   * How many builds' sourcemaps to keep, newest first. Default: 5.
   *
   * A deploy replaces the build output, and with it the maps that turn a
   * minified frame back into a source line. That matters most right after a
   * release, when errors are still arriving from the version being replaced —
   * so each build files a copy of its maps beside the database, under an id
   * derived from what it produced.
   *
   * Keyed by build rather than by release because a release name does not
   * identify a build: `dev` is reused on every rebuild, and a tag gets built
   * again after a failed deploy. Set to `0` to keep none, at the cost of
   * losing older traces on every deploy. Maps are large — this is a disk
   * budget, not a retention policy.
   */
  keepSourcemapsFor?: number
  /**
   * Extra key patterns to redact from captured payloads, on top of the
   * built-in set (authorization, cookie, password, token, secret, …).
   */
  scrubKeys?: string[]
  /** What to drop before it is ever recorded. */
  ignore?: MonitorIgnoreOptions
}

export interface MonitorIgnoreOptions {
  /**
   * HTTP statuses to skip. Defaults to every 4xx: a 404 says a client asked
   * for something that is not there, which is not a fault in the application
   * and would otherwise bury the errors that are.
   *
   * Set to `[]` to record them.
   */
  statuses?: number[]
  /** Messages to skip, as substrings or `/regex/` strings. */
  messages?: string[]
  /** Request paths to skip, as substrings or `/regex/` strings. */
  routes?: string[]
  /** Error types to skip, e.g. `AbortError` for cancelled navigations. */
  types?: string[]
}

/**
 * The collector's own state.
 *
 * Everything here answers "is what I am looking at the truth?" — an empty
 * dashboard means one thing when collection is healthy and something else
 * entirely when the database stopped accepting writes an hour ago.
 */
export interface MonitorHealth {
  /** False when the database could not be opened; nothing is being recorded. */
  enabled: boolean
  /** Why collection is off. Only present when `enabled` is false. */
  reason?: string
  /** Bytes occupied by stored data — pages in use, not the size of the file. */
  bytes: number
  /** The configured ceiling, in bytes. `0` when disabled. */
  maxBytes: number
  /** True while the ceiling cannot be met without emptying the database. */
  overCeiling: boolean
  /** Events buffered but not yet written. Persistently non-zero means trouble. */
  pending: number
  /** Request counters buffered but not yet written. */
  pendingCounters: number
  /** Events discarded because they could not be written. */
  dropped: number
  /** Epoch ms until which size-triggered flushes are suspended. `0` when healthy. */
  retryAfter: number
  issues: number
  events: number
  retentionDays: number
  maxIssues: number
}

/** A single parsed stack frame, before or after sourcemap resolution. */
export interface MonitorFrame {
  file: string
  line: number
  /** 1-based, as V8 reports it. Converted at the trace-mapping boundary. */
  column: number
  function?: string
  /** Set once resolved through a sourcemap. */
  original?: {
    file: string
    line: number
    column: number
    function?: string
    /** Source excerpt around the failing line, when available. */
    context?: { line: number, text: string }[]
  }
  /**
   * Why `original` is absent, when it is.
   *
   * `no-mapping` — a map was found and read, and it covers no position here.
   * That is the ordinary case for a frame inside vendor code.
   *
   * `no-map` — no map for this file could be found at all. Usually the event
   * came from a build this process cannot see: a dev server showing errors
   * recorded by the production build beside it names hashed assets Vite never
   * served. The distinction matters because the two need different words —
   * telling somebody "no sourcemap covered this frame" when the map is on disk
   * one directory away sends them looking in the wrong place.
   */
  unresolved?: 'no-map' | 'no-mapping'
}

export type MonitorSide = 'client' | 'server'

/** What the collectors hand to the store. */
export interface MonitorEvent {
  side: MonitorSide
  type: string
  message: string
  stack?: string
  timestamp: number
  /** Request/route/browser context. Already scrubbed. */
  context?: Record<string, unknown>
  breadcrumbs?: MonitorBreadcrumb[]
  /** Nitro's `tags` (request, response, plugin, cache, unhandledRejection, …). */
  tags?: string[]
  /** Dimensions the dashboard groups and filters by. Stored as columns. */
  facets?: MonitorFacets
}

/**
 * The dimensions an issue can be broken down by.
 *
 * Deliberately non-personal: a per-tab random session id, a coarse browser and
 * OS, a device class and the release. None of it identifies a visitor, and
 * together it answers the question a breakdown exists for — what do these
 * occurrences have in common.
 */
export interface MonitorFacets {
  /** Random per-tab id. Groups events, identifies nobody. */
  session?: string
  browser?: string
  /** Major version only. */
  browserVersion?: string
  os?: string
  osVersion?: string
  deviceType?: string
  /** Application version, from `monitor.release`. */
  release?: string
}

/** The facet dimensions that can be counted and filtered on. */
export type MonitorFacetName =
  | 'browser'
  | 'browserVersion'
  | 'os'
  | 'osVersion'
  | 'deviceType'
  | 'release'
  | 'route'

/** One value of a facet, with how many events carry it. */
export interface MonitorFacetValue {
  value: string
  count: number
  /** Share of the events in scope, 0–1. */
  share: number
}

export type MonitorFacetCounts = Record<MonitorFacetName, MonitorFacetValue[]>

/** A filter over facet values. Multiple values of one facet are OR-ed. */
export type MonitorFacetFilter = Partial<Record<MonitorFacetName, string[]>>

export interface MonitorBreadcrumb {
  type: 'navigation' | 'fetch' | 'console' | 'click'
  timestamp: number
  message: string
  data?: Record<string, unknown>
}

/** Everything the overview screen renders. */
export interface MonitorOverview {
  /** How far back the numbers reach. */
  windowMs: number
  serverErrors: number
  clientErrors: number
  totalEvents: number
  issueCount: number
  unresolvedCount: number
  /** Requests counted in the window — the denominator for `errorRate`. */
  requestCount: number
  failedRequestCount: number
  /** Undefined when no requests were counted: "no data" is not "no failures". */
  errorRate?: number
  trend: { bucket: number, server: number, client: number }[]
  topRoutes: { route: string, total: number, failed: number, rate: number }[]
  /** The issue behind the most occurrences, and its share of them. */
  topIssue?: { issue: MonitorIssue, share: number }
  recent: MonitorIssue[]
}

/** One release, and what happened while it was deployed. */
export interface MonitorRelease {
  release: string
  events: number
  issues: number
  /**
   * Issues seen for the first time in this release.
   *
   * The number that says something about the deploy. A total error count
   * mostly reflects how much traffic a release served; this says what it
   * introduced.
   */
  newIssues: number
  sessions: number
  firstSeen: number
  lastSeen: number
}

/** Traffic and failures for one route shape. */
export interface MonitorRouteStat {
  route: string
  total: number
  failed: number
  /** Failed over total, 0–1. */
  rate: number
}

/** How many people saw an error, and who saw the most. */
export interface MonitorSessionStats {
  /** Distinct sessions with at least one error. */
  affected: number
  events: number
  worst: {
    session: string
    events: number
    issues: number
    firstSeen: number
    lastSeen: number
  }[]
}

/** An aggregate row as the dashboard sees it. */
export interface MonitorIssue {
  fingerprint: string
  type: string
  message: string
  side: MonitorSide
  count: number
  firstSeen: number
  lastSeen: number
  resolved: boolean
  /** `file.ts:12` — where it broke, taken from the most recent occurrence. */
  culprit?: string
  /** Request path, for server errors and client page context. */
  route?: string
  method?: string
  /** HTTP status, when the error carried one. */
  status?: number
}
