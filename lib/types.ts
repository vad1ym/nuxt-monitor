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
  /**
   * Connection string for an external database.
   *
   * Unset — the default — stores everything in a SQLite file under
   * `storageDir`, which needs no service and is what the module is designed
   * around.
   *
   * Read at **runtime**, so `NUXT_MONITOR_DATABASE_URL` can point one build at
   * a different database per environment. A credential does not belong in a
   * config file, and it certainly does not belong in a build artefact.
   */
  databaseUrl?: string
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
  /** Where alerts go, and what is worth one. */
  notifications?: MonitorNotificationOptions
}

/**
 * Alerting.
 *
 * Off until a channel is configured. The defaults underneath are deliberately
 * quiet rather than deliberately complete: an alerting feature is judged by
 * what it does *not* send, because the first day of noise is the day somebody
 * mutes the chat, and a muted chat is worth less than no alerts at all — it
 * looks like coverage.
 */
export interface MonitorNotificationOptions {
  /** Master switch. Default: `true` when at least one channel is configured. */
  enabled?: boolean
  /**
   * Where messages go. Every configured channel receives every alert that
   * passes the triggers; per-channel routing arrives with watcher groups.
   */
  channels?: MonitorChannelOptions[]
  /** What is worth sending. */
  triggers?: MonitorTriggerOptions
  /**
   * Absolute URL of the dashboard, e.g. `https://app.example.com/_monitor`.
   *
   * An alert without a link is a notification that something happened
   * somewhere. The module knows its own route but not the host it is served
   * under — a request would tell it, and alerts are raised on a timer and from
   * background flushes where there is no request. So it has to be given.
   */
  dashboardUrl?: string
  /**
   * Minutes of silence per issue after an alert about it. Default: 60.
   *
   * The single most important number here. Without it a spike sends one message
   * per occurrence, which is how alerting gets turned off.
   */
  cooldownMinutes?: number
  /**
   * How long new alerts are held back so they can travel together, in seconds.
   * Default: 30.
   *
   * A deploy that breaks four things breaks them within the same second. Four
   * messages say the same thing as one message listing four, and cost four
   * times the attention. `0` sends each immediately.
   */
  groupWindowSeconds?: number
  /** When not to send at all. */
  quietHours?: MonitorQuietHours
  /**
   * Credentials for the first channel of each kind, supplied at **runtime**.
   *
   * These exist because a channel is an array entry, and Nuxt can only override
   * a `runtimeConfig` value that is a plain key — `NUXT_MONITOR_*` cannot reach
   * into a list. Without them the only place to put a bot token is the config
   * file, where it is resolved at build time and ends up inside the build
   * artefact: a secret in an image, copied to wherever that image goes.
   *
   * `databaseUrl` is read at runtime for exactly this reason, and a bot token
   * deserves the same treatment. Set `NUXT_MONITOR_TELEGRAM_TOKEN`,
   * `NUXT_MONITOR_TELEGRAM_CHAT_ID` or `NUXT_MONITOR_WEBHOOK_URL` when the
   * server starts and leave the corresponding field off the channel.
   *
   * A value here fills in only where the channel left one blank, so a config
   * that does spell out a token keeps working.
   */
  telegramToken?: string
  telegramChatId?: string
  webhookUrl?: string
}

/**
 * One destination.
 *
 * A discriminated union rather than a bag of optional fields, so a Telegram
 * channel missing its chat id is a type error at the config site rather than a
 * silent no-op at three in the morning.
 */
export type MonitorChannelOptions =
  | MonitorTelegramChannel
  | MonitorWebhookChannel

interface MonitorChannelBase {
  /**
   * Name shown in the delivery log. Defaults to the channel type.
   *
   * Worth setting once there are two of a kind — "telegram" twice in a log
   * cannot answer which chat did not receive the message.
   */
  name?: string
  /** Skip this channel without deleting its configuration. */
  enabled?: boolean
  /**
   * Only send alerts about these priority groups, from `exception()`.
   *
   * Unset — the default — sends everything to this channel. Named, it becomes
   * a channel for one concern: the payments group to the payments chat, where
   * the people who can act on it are, and not to a general channel where it is
   * one line among fifty.
   *
   * Caught errors carry no group, so a channel with `groups` set will not
   * receive them. That is the point of naming one; a channel that wants both
   * should be left unfiltered, or a second channel added.
   */
  groups?: string[]
  /**
   * Lowest level worth sending here, for reports raised by `exception()`.
   *
   * `warning` on a chat that people read during the day and `critical` on the
   * one that wakes somebody is the arrangement this exists for. Caught errors
   * are treated as `error`, since that is what being thrown amounts to.
   */
  minLevel?: MonitorLevel
}

export interface MonitorTelegramChannel extends MonitorChannelBase {
  type: 'telegram'
  /**
   * Bot token from `@BotFather`.
   *
   * Prefer leaving this unset and supplying `NUXT_MONITOR_TELEGRAM_TOKEN` when
   * the server starts — see the note on secrets below. A value written here is
   * resolved at build time and ends up inside the build artefact.
   */
  token?: string
  /** Target chat. A user id, a group id (negative) or `@channelname`. */
  chatId?: string
}

export interface MonitorWebhookChannel extends MonitorChannelBase {
  type: 'webhook'
  /** Receives a POST with the alert as JSON. */
  url?: string
  /** Extra headers, for a signature or a bearer token. */
  headers?: Record<string, string>
}

export interface MonitorTriggerOptions {
  /** Alert the first time a fingerprint is seen. Default: `true`. */
  newIssue?: boolean
  /**
   * Alert when a resolved issue happens again. Default: `true`.
   *
   * The most valuable of the three: somebody claimed this was fixed, and the
   * claim turned out to be false. Nothing else in the tool contradicts a human
   * on the record.
   */
  regression?: boolean
  /**
   * Occurrence counts that raise an alert when an issue crosses them.
   * Default: `[10, 100, 1000]`, i.e. an order of magnitude at a time.
   *
   * Set to `[]` to alert only on new issues and regressions.
   */
  thresholds?: number[]
}

/**
 * A window in which nothing is sent.
 *
 * Not "delay until morning": an alert about a fault that is over by then is
 * worth less than the sleep it would have cost, and one about a fault that is
 * still going will be raised again by the next occurrence anyway. Suppressed
 * alerts are still written to the log with the reason, so the morning question
 * "did anything happen overnight" has an answer.
 */
export interface MonitorQuietHours {
  /** `HH:MM`, inclusive. May wrap past midnight, which is the usual case. */
  from: string
  /** `HH:MM`, exclusive. */
  to: string
  /**
   * IANA zone the window is read in, e.g. `Europe/Kyiv`. Defaults to the
   * server's. A server on UTC and a team that is not makes "22:00" mean the
   * wrong thing by however many hours, silently.
   */
  timezone?: string
  /** Days the window applies to, `0` Sunday–`6` Saturday. Default: every day. */
  days?: number[]
}

/** Why an alert was raised. */
export type MonitorAlertReason = 'new-issue' | 'regression' | 'threshold' | 'test'

/** One thing worth telling somebody about. */
export interface MonitorAlert {
  reason: MonitorAlertReason
  issue: MonitorIssue
  /** The threshold that was crossed, for `threshold` alerts. */
  threshold?: number
  at: number
}

/** One attempt to deliver one alert to one channel. */
export interface MonitorDelivery {
  id: number
  at: number
  channel: string
  reason: MonitorAlertReason
  /** Fingerprint of the issue, or of the first one when several were grouped. */
  fingerprint?: string
  /** How many alerts this message carried. */
  alerts: number
  status: 'sent' | 'failed' | 'suppressed'
  /** Error text for `failed`, or which rule silenced it for `suppressed`. */
  detail?: string
  /**
   * What the alert was about, when a single issue behind it still exists.
   *
   * Carried so a log row can be matched against a message somebody remembers
   * receiving — "New issue, sent, 10m ago" names nothing, and naming nothing is
   * no use to the one question this log is opened to answer.
   */
  issue?: { type: string, message: string }
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

/**
 * How much attention something deserves.
 *
 * Only for reports raised by hand. A caught error has no level — the fact that
 * it was thrown is the whole of what is known about it — but a deliberate
 * report is made by someone who knows whether a mismatched payment total is a
 * curiosity or an emergency, and throwing that knowledge away at the call site
 * means rediscovering it later from a message.
 */
export type MonitorLevel = 'info' | 'warning' | 'error' | 'critical'

/** What `exception()` accepts alongside the message. */
export interface MonitorExceptionOptions {
  /** Default: `error`. */
  level?: MonitorLevel
  /**
   * A named area this belongs to — `payments`, `data-integrity`.
   *
   * Free-form on purpose: the set of things worth watching is the
   * application's, not the module's. Groups are what notification routing is
   * configured against, so the name is the contract between a call site and an
   * alerting rule.
   */
  group?: string
  /** Extra context, scrubbed and stored with the occurrence like any other. */
  meta?: Record<string, unknown>
}

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
  /**
   * Set when the report was made by `exception()` rather than caught.
   *
   * Kept distinct from a caught error throughout. The two answer different
   * questions — "what broke" against "what did somebody decide was worth
   * watching" — and a list that mixes them silently makes the second
   * unfindable.
   */
  manual?: boolean
  level?: MonitorLevel
  group?: string
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

/**
 * One dimension's values, and whether the list was cut.
 *
 * `more` rather than a total count of distinct values: the panel only needs to
 * decide whether to offer "show more", and counting the whole tail costs a
 * second aggregate over the events table to answer a question nobody asked.
 */
export interface MonitorFacetGroup {
  values: MonitorFacetValue[]
  more: boolean
}

export type MonitorFacetCounts = Record<MonitorFacetName, MonitorFacetGroup>

/**
 * When one issue's stored occurrences happened.
 *
 * `stored` is how many rows the points were drawn from, which can be fewer
 * than the issue's `count`: occurrences are trimmed per issue, so a busy issue
 * keeps recent history rather than all of it. The card compares the two and
 * says so rather than drawing a partial history as if it were the whole one.
 */
export interface MonitorIssueTrend {
  points: { at: number, count: number }[]
  stored: number
  /** Bucket width in milliseconds. Zero when there is nothing to draw. */
  step: number
}

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
  /**
   * How many distinct sessions saw an error, and how often each did.
   *
   * Carried on the overview because it is the one question a count of events
   * cannot answer: fifty errors is an outage across fifty sessions and one
   * person stuck in a retry loop across two. It had a screen of its own, which
   * meant the distinction was only ever seen by someone who went looking.
   */
  affectedSessions: number
  /**
   * The most recent release that introduced an issue, if any did.
   *
   * "Did the last deploy break something" is a first-screen question, not one
   * worth navigating to a section for.
   */
  latestRelease?: { release: string, newIssues: number, events: number, lastSeen: number }
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
  /** Methods seen on this route, busiest first — `GET`, `POST`, … */
  methods?: string[]
  /** Requests per status class, keyed `2xx` / `3xx` / `4xx` / `5xx`. */
  classes?: Record<string, number>
}

/**
 * Traffic as a whole, not route by route.
 *
 * The routes table answers "which endpoint", which is only half of what a
 * traffic screen is for: whether the application is busy, whether failures are
 * server faults or bad requests, and when they happened are questions about
 * the total, and no row in a per-route list carries them.
 */
export interface MonitorTrafficStats {
  total: number
  failed: number
  /** Failed over total, 0–1. Undefined when nothing was counted. */
  rate?: number
  /** Requests per status class across every route. */
  classes: Record<string, number>
  /** Requests per method, busiest first. */
  methods: { method: string, count: number }[]
  /** Requests over time, in the same buckets the error chart uses. */
  trend: { bucket: number, total: number, failed: number }[]
  routes: MonitorRouteStat[]
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
  /**
   * Put aside as not worth acting on — an extension, a bot, someone else's
   * problem. Separate from `resolved`, which claims a fix that was made.
   */
  ignored: boolean
  /** `file.ts:12` — where it broke, taken from the most recent occurrence. */
  culprit?: string
  /** Request path, for server errors and client page context. */
  route?: string
  method?: string
  /** HTTP status, when the error carried one. */
  status?: number
  /** Raised by `exception()` rather than caught. */
  manual?: boolean
  /** Only ever set on a manual report. */
  level?: MonitorLevel
  group?: string
}
