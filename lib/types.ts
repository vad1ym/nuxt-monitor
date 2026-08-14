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
  /** What of the failing request to keep alongside the stack. */
  capture?: MonitorCaptureOptions
  /** What to drop before it is ever recorded. */
  ignore?: MonitorIgnoreOptions
  /** Where alerts go, and what is worth one. */
  notifications?: MonitorNotificationOptions
  /**
   * Named parts of the application, and which of them are worth an alert.
   *
   * A group labels errors nobody annotated by hand: a failure in
   * `/api/checkout` belongs to payments whether or not somebody remembered to
   * call `exception()` with a group. The name is then what a notification
   * channel subscribes to and what the issue list filters by.
   *
   * ```ts
   * groups: {
   *   payments: { routes: ['/api/checkout/**'], notify: true },
   *   'third-party': { messages: ['stripe', '/timeout of \\d+ms/'] },
   * }
   * ```
   *
   * Read-only from the dashboard's point of view. These describe the
   * architecture of the application rather than an observation about it, so
   * they belong beside the code and in review — unlike resolving or ignoring an
   * issue, which is what somebody concluded this afternoon.
   */
  groups?: MonitorGroupOptions
  /**
   * What to store when one issue is happening constantly.
   *
   * Off by default: on an ordinary application every occurrence fits, and
   * storing all of them is strictly better. Turn it on when a single failing
   * route can outproduce everything else — the fiftieth identical stack in a
   * minute carries nothing the first ten did not, but it costs the same to
   * write and pushes other events out of the shared buffer.
   *
   * **Counts stay exact.** Occurrences that are not stored are still counted,
   * so an issue never under-reports how often it happened. Only the event
   * bodies — stack, context, breadcrumbs — are thinned.
   */
  sampling?: MonitorSamplingOptions
}

/** Group name → the rule that assigns it. */
export type MonitorGroupOptions = Record<string, MonitorGroupRule | string[]>

export interface MonitorGroupRule {
  /**
   * Path patterns: `**` spans separators, `*` does not, `:param` is one
   * segment. Matched against the raw path, so a rule is written the way the
   * files in `server/api` are named.
   */
  routes?: string[]
  /**
   * Message patterns, as substrings or `/regex/` strings — the same spelling
   * `ignore` uses.
   *
   * For the faults a path cannot find: a third-party provider rarely breaks on
   * its own route, it breaks inside yours.
   */
  messages?: string[]
  /**
   * Alert on errors in this group. Default: `false`.
   *
   * Everything that already governs alerting still applies — the per-issue
   * cooldown, the grouping window, quiet hours, and any channel that names
   * this group. This flag decides whether the group is worth an alert at all,
   * not whether it bypasses the rules that keep alerting bearable.
   */
  notify?: boolean
}

/**
 * What of the failing request to keep beside the stack.
 *
 * A stack says where the code broke; a body says what broke it. "Cannot read
 * properties of undefined" is one bug or fifty depending on what was posted,
 * and reproducing it without the payload is guesswork — so this is the single
 * biggest thing a stored error can carry beyond the trace itself.
 *
 * It is also the single most dangerous. A request body is where passwords,
 * card numbers and personal data live, so the request half is **off by
 * default** and stays off unless somebody turns it on deliberately, having
 * thought about what their endpoints receive. The response half is on: it is
 * generated by the application rather than supplied by a visitor, and for a
 * failure it is usually an error envelope — the thing you would have asked
 * for first.
 *
 * Everything kept here goes through the same redaction as the rest of the
 * event. That is a safety net, not a licence: it matches keys, so a token
 * inside a field called `data` survives it.
 */
export interface MonitorCaptureOptions {
  /**
   * Store the request body of a failing request. Default: `false`.
   *
   * Only for failures — a successful request is never read, so this cannot
   * become a log of everything your users typed.
   */
  request?: boolean
  /**
   * Store the response body of a failing request. Default: `true`.
   *
   * Only 5xx responses, and only when they carry a body. A 4xx is somebody
   * asking for something absent, and is already ignored by default.
   */
  response?: boolean
  /**
   * Ceiling on each stored body, in bytes. Default: 8192.
   *
   * Truncated rather than dropped past the limit, with a marker: the first few
   * kilobytes of a payload almost always contain the field that mattered.
   */
  maxBytes?: number
}

export interface MonitorSamplingOptions {
  /**
   * Occurrences stored per issue per minute before thinning begins.
   *
   * Unset or `0` stores everything, which is the default. `20` is a sensible
   * starting point: enough to see an issue from several angles, few enough
   * that a loop cannot fill the database with copies.
   */
  burst?: number
  /** Of the occurrences past the burst, keep one in this many. Default: 20. */
  keepOneIn?: number
  /** Length of the burst window in ms. Default: 60000. */
  windowMs?: number
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
   * `NUXT_MONITOR_TELEGRAM_CHAT_ID`, `NUXT_MONITOR_SLACK_WEBHOOK_URL`,
   * `NUXT_MONITOR_SLACK_TOKEN` or `NUXT_MONITOR_WEBHOOK_URL` when the server
   * starts and leave the corresponding field off the channel.
   *
   * A value here fills in only where the channel left one blank, so a config
   * that does spell out a token keeps working.
   */
  telegramToken?: string
  telegramChatId?: string
  /** A Slack incoming webhook URL is a credential: holding it is posting rights. */
  slackWebhookUrl?: string
  slackToken?: string
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
  | MonitorSlackChannel
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

/**
 * Slack, by either of the two ways it accepts a message.
 *
 * An incoming webhook is a URL with the destination channel baked into it, set
 * up in about a minute and needing no app, no scopes and no token. A bot token
 * needs all three, and buys the one thing the webhook cannot do: send to
 * several channels from one credential — the payments alerts to `#payments`
 * and everything else to `#alerts` without creating a second hook.
 *
 * Both are the same channel type rather than two, because they differ only in
 * where the message is posted. The message itself, what qualifies for it and
 * everything above delivery is identical, and splitting the type would have
 * duplicated all of that to express the choice of endpoint.
 */
export interface MonitorSlackChannel extends MonitorChannelBase {
  type: 'slack'
  /**
   * Incoming webhook URL, `https://hooks.slack.com/services/…`.
   *
   * Prefer leaving this unset and supplying `NUXT_MONITOR_NOTIFICATIONS_SLACK_WEBHOOK_URL`
   * at runtime: the URL is a credential — anyone holding it can post to the
   * channel — and a value written here is baked into the build artefact.
   */
  webhookUrl?: string
  /**
   * Bot token, `xoxb-…`, for `chat.postMessage`.
   *
   * Needs the `chat:write` scope, and the bot has to be a member of the target
   * channel — Slack answers `not_in_channel` otherwise, which the delivery log
   * reports verbatim. Ignored when `webhookUrl` is set: a hook already names
   * its destination, so honouring both would mean sending twice.
   */
  token?: string
  /**
   * Where the bot posts: `#alerts`, or a channel id like `C0123456789`.
   *
   * Required alongside `token` and meaningless without it. An id survives the
   * channel being renamed; a name is what people can actually read in a config
   * file, so both are accepted.
   */
  channel?: string
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
  /**
   * Alert when an issue starts happening far faster than it used to.
   * Off by default; `true` uses ×5.
   *
   * The trigger the count-based ones cannot express. An issue that has ticked
   * along at two an hour for a week and does four hundred in a minute has not
   * crossed a new threshold — it passed 100 and 1000 long ago — so nothing is
   * said, at exactly the moment something changed. This compares the rate now
   * against the rate before, which is what "it got worse" actually means.
   *
   * Needs history to compare against: an issue with no established rate is
   * simply new, and `newIssue` already covers that.
   */
  spike?: boolean | { factor?: number, minimum?: number }
  /**
   * Alert when the application's failure rate crosses this fraction, e.g.
   * `0.25` for a quarter of requests. Off by default.
   *
   * Application-wide rather than per issue, and the only trigger here that can
   * fire when no single issue is remarkable: fifty different faults each too
   * small to alert on still add up to a checkout nobody can complete. Measured
   * against requests served, so it stays quiet on a quiet night — three
   * failures out of four requests at 4am is not an outage.
   */
  errorRate?: number | { above: number, minimumRequests?: number }
  /**
   * Alert when the application stops reporting anything at all. Off by
   * default; `true` uses two hours.
   *
   * The only trigger here that fires on an *absence*, and the one that decides
   * whether any of the others can be trusted. Every other rule watches for
   * something getting worse, so a collector that has died — a bad deploy, an
   * intake answering 404 behind a changed route prefix, a browser plugin that
   * never loaded — produces perfect silence, and silence is indistinguishable
   * from a healthy afternoon. The most dangerous chart in monitoring is the
   * one that went flat, and nothing was watching for it.
   *
   * Compared against this application's own history rather than a fixed
   * expectation: a tool that normally sees four requests an hour has not
   * broken by seeing none for twenty minutes. Nothing is claimed until the
   * database has enough history to say what normal was.
   *
   * `after` is how long the quiet has to last, in milliseconds. Keep it well
   * above a deploy's restart window, or every deploy raises one.
   */
  silence?: boolean | { after?: number }
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
export type MonitorAlertReason =
  | 'new-issue'
  | 'regression'
  | 'threshold'
  | 'watched'
  | 'spike'
  | 'error-rate'
  | 'silence'
  | 'test'

/** One thing worth telling somebody about. */
export interface MonitorAlert {
  reason: MonitorAlertReason
  /**
   * The issue this is about.
   *
   * Absent only for `error-rate`, which is a statement about the application
   * rather than about any one fault — that is the whole reason it exists, and
   * naming an arbitrary issue on it would point the reader at a symptom that
   * may not be the cause.
   */
  issue?: MonitorIssue
  /** The threshold that was crossed, for `threshold` alerts. */
  threshold?: number
  /** How much faster than before, for `spike` alerts. */
  factor?: number
  /** The failure rate and what it was measured over, for `error-rate`. */
  rate?: { failed: number, total: number }
  /**
   * How long the application has been silent, for `silence` alerts.
   *
   * Carried rather than left to the message to compute, because the reader's
   * first question is "since when" — and the answer decides whether this is a
   * deploy still restarting or a collector that died last night.
   */
  quietFor?: { sinceMs: number, lastSeen: number }
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
   * HTTP statuses to skip. Default: `[404, 429]`.
   *
   * Only the two that are never the application's own fault — a stale link or
   * a bot, and the rate limiter doing its job. Everything else is recorded,
   * **including the rest of the 4xx range**.
   *
   * That default used to be every 4xx, and it hid real bugs. A status code is
   * a claim an application makes about itself and applications make it
   * inconsistently: plenty of APIs answer `400` or `422` for "your own
   * frontend sent nonsense". A 422 raised by a page's own `$fetch` — a `null`
   * reaching an API that rejects it — takes the page down with an error screen
   * and never appeared here at all. The bias is towards recording, because a
   * missed error costs an afternoon and an extra row costs one click on Ignore.
   *
   * Set to `[]` to record even those two.
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
  /** True when admission control is on, so stored events are a subset. */
  sampling: boolean
  /**
   * Occurrences counted but whose bodies were not stored.
   *
   * Not a loss to report as one: the counts are exact either way. It exists so
   * a database holding fewer events than its issues claim reads as sampling
   * rather than as something broken.
   */
  sampled: number
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
 * What kind of thing broke: an endpoint, a page, or a static asset.
 *
 * Defined here rather than beside the classifier because it is part of the
 * public shape — it appears on every issue the API returns.
 */
export type MonitorRouteKind = 'api' | 'page' | 'asset'

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
  /**
   * Whether this was an endpoint, a page or an asset.
   *
   * `side` says which machine the code ran on, which stops being the useful
   * distinction once an application has both: `/api/orders` returning 500 to
   * every mobile client and `/checkout` failing to render for one visitor are
   * both "a server error", and they are not the same problem.
   */
  kind?: MonitorRouteKind
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
  /** `api`, `page` or `asset`. */
  | 'kind'
  /** A named group, from `exception()` or from a config rule. */
  | 'group'

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

/**
 * What the window before this one looked like.
 *
 * Only the figures a change is meaningful for. Counts and rates compare
 * cleanly; the trend, the route table and the issue lists do not — a previous
 * trend is a second chart rather than a delta, and drawing one behind the
 * other says less than either alone.
 */
export interface MonitorPrevious {
  requests: number
  failed: number
  /** Undefined when nothing was served, exactly as in the current window. */
  errorRate?: number
  events: number
  issues: number
  newIssues: number
  affectedSessions: number
  sessions: number
}

/**
 * How long requests took.
 *
 * The measurement that separates a monitor from an error tracker: everything
 * else here starts with something throwing, so an application answering 200 in
 * eight seconds registered as perfectly healthy while being unusable.
 *
 * Percentiles, never a mean. Latency distributions have long tails, so a mean
 * sits in the empty space between the fast majority and the slow minority —
 * describing nobody — and it is the last number to move when the tail is what
 * broke.
 */
export interface MonitorLatency {
  /** Requests measured. The denominator every percentile here is out of. */
  requests: number
  /** Undefined when nothing was measured: "no data" is not "instant". */
  p50?: number
  p95?: number
  p99?: number
  /** The slowest routes by p95, since an average across all of them hides it. */
  routes: {
    route: string
    requests: number
    p50?: number
    p95?: number
    p99?: number
  }[]
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
  /**
   * Requests per status class, keyed `2xx` / `3xx` / `4xx` / `5xx`, plus
   * `excused` for the statuses that are counted but never treated as failures
   * — `404` and `429`. They are kept apart at write time because this table
   * stores the class and not the status, so once they joined `4xx` no query
   * could separate them again.
   */
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

/**
 * One day of the calm-days bar.
 *
 * The verdict is about the day, not about the process: whether anything
 * happened that somebody should have known about. A day nothing was recorded
 * for is `unknown` rather than calm — "no errors" and "no data" look identical
 * in the database and mean opposite things.
 */
export interface MonitorUptimeDay {
  /** Start of the day, epoch ms, in the server's zone. */
  day: number
  /** Issues seen for the first time that day, ignored ones excluded. */
  newIssues: number
  /** How many of those were in a group configured with `notify: true`. */
  watchedIssues: number
  requests: number
  failed: number
  /** Failed over total, 0–1. Undefined when nothing was served. */
  rate?: number
  /**
   * `calm` — nothing serious happened.
   * `notable` — a watched group failed, or several new issues appeared at once.
   * `bad` — a great many new issues, or a failure rate that means an outage.
   * `unknown` — nothing was recorded, for whatever reason.
   */
  state: 'calm' | 'notable' | 'bad' | 'unknown'
}

/**
 * One row of a dashboard breakdown.
 *
 * Errors and traffic side by side, because neither means anything alone. 400
 * errors on Chrome is a number; 400 errors on Chrome against 90% of the page
 * views is the shape of the audience; 400 against 6% is the answer.
 */
export interface MonitorDashboardSlice {
  value: string
  errors: number
  /** Share of the errors in scope, 0–1. */
  errorShare: number
  /** Page views counted for this value. Zero when the audience is unknown. */
  traffic: number
  /** Share of counted page views, 0–1. Undefined when none were counted. */
  trafficShare?: number
  /**
   * Errors per page view, relative to the application's average.
   *
   * The one number worth ranking by: `6.7` means this slice produces errors at
   * nearly seven times the rate the rest of the traffic does. Undefined when
   * there is no traffic to compare against.
   */
  lift?: number
  /**
   * Errors per page view for this slice, as a plain rate.
   *
   * `lift` says how unusual the slice is; this says how bad it is. A browser
   * at 3× the average is worth investigating either way, but 3× of one error
   * in ten thousand and 3× of one in five are different afternoons.
   */
  errorsPerView?: number
}

/** One dimension of the dashboard, with its rows. */
export interface MonitorDashboardBreakdown {
  facet: MonitorFacetName
  slices: MonitorDashboardSlice[]
  /** Errors not covered by the rows above — the tail, kept honest. */
  otherErrors: number
}

/** Everything the dashboard screen draws. */
export interface MonitorDashboard {
  windowMs: number
  /** Traffic, failures and error counts over the window. */
  totals: {
    requests: number
    failed: number
    /** Failed over requests, 0–1. Undefined when nothing was served. */
    errorRate?: number
    events: number
    issues: number
    newIssues: number
    affectedSessions: number
    /**
     * Sessions that visited at all — what `affectedSessions` is out of.
     *
     * Zero on a database that predates session counting, and on one whose
     * client collector is not running. Both read correctly as "no baseline",
     * which is why a share against this must be withheld rather than shown as
     * 0% when it is zero.
     */
    sessions: number
  }
  /**
   * The same figures for the window immediately before this one.
   *
   * Every tile on this screen was absolute, and an absolute number is close to
   * unreadable on its own: "120 errors" is a quiet morning or a fire depending
   * entirely on whether the day before was 15 or 400, and nothing on screen
   * said which. A count beside its predecessor is a direction, which is what
   * anybody opens a dashboard to find out.
   *
   * A nested block rather than a `previousEvents` beside every field: the
   * comparison is one idea, and spread across seven properties half of them
   * get added and half get forgotten.
   *
   * **Absent when the window before this one was never observed** — a database
   * younger than one window has nothing behind it, and reporting "up from 0"
   * there would be the tool's loudest statement made from no evidence. Absent
   * is different from a window of zeroes, which is a real and useful
   * measurement: a healthy previous day genuinely had no errors.
   */
  previous?: MonitorPrevious
  /**
   * How long requests took.
   *
   * The only figure on this screen not derived from something throwing, and
   * the reason the screen can now see a fault that never does: an endpoint
   * answering 200 in eight seconds registered nowhere at all.
   */
  latency: MonitorLatency
  /** Requests and errors on one axis, so a spike in both is not read as one. */
  trend: { bucket: number, requests: number, failed: number, errors: number }[]
  breakdowns: MonitorDashboardBreakdown[]
  /** The worst routes by failure rate, with enough traffic to mean it. */
  routes: MonitorRouteStat[]
  /**
   * The single biggest contributor, and its share of the errors.
   *
   * In most incidents one fault accounts for most of the noise, and finding it
   * by scrolling a list ranked by count is work the screen can do instead.
   */
  topIssue?: { issue: MonitorIssue, share: number }
  /** Newest issues, for the "what just happened" glance. */
  recent: MonitorIssue[]
  /**
   * The most recent release that introduced something.
   *
   * "Did the last deploy break anything" is a first-screen question, and the
   * number that answers it is what *first appeared* in that release rather
   * than how much happened while it was out.
   */
  latestRelease?: { release: string, newIssues: number, events: number, lastSeen: number }
  /**
   * Where each release starts, for marking the chart.
   *
   * "It started after the deploy" is the first thing anybody wants to know
   * during an incident, and it is a question about *shape*: how much was
   * happening before a line against how much after. A filter by release cannot
   * answer it — narrowing to one release hides the very comparison being made
   * — so releases are drawn on the same axis as the errors instead.
   */
  deploys: MonitorDeploy[]
}

/**
 * A release, and when it first showed up.
 *
 * `at` is the first event carrying that release, which is the closest thing to
 * a deploy time this module can know without being told about the deploy. It
 * is later than the deploy itself by however long it took for the first error
 * or page view to arrive — seconds on a busy application, longer on a quiet
 * one. Named `at` rather than `deployedAt` for exactly that reason: it is when
 * the release was first *seen*, not when it went out.
 */
export interface MonitorDeploy {
  release: string
  at: number
  /** Issues that appeared for the first time in this release. */
  newIssues: number
}

/**
 * The releases one issue spans.
 *
 * "Introduced in 1.8.2, last seen in 1.8.3" is the sentence somebody wants
 * before reading a line of the stack: it says whether a deploy caused this and
 * whether the next one fixed it.
 */
export interface MonitorIssueReleases {
  /** The release its earliest surviving occurrence carried. */
  first?: string
  /** The release its newest occurrence carried. */
  last?: string
  /** How many distinct releases it has been seen in. */
  count: number
  /**
   * Whether older occurrences have been trimmed away.
   *
   * `maxEventsPerIssue` keeps the newest occurrences per issue, so a long-lived
   * busy issue can lose the evidence of where it began — and would then appear
   * to have been introduced by whichever release the surviving rows start in.
   * Blaming a deploy that was innocent is worse than saying nothing, so the
   * screen hedges when this is set.
   */
  partial: boolean
}

/** One cell of the when-does-it-happen grid. */
/**
 * Errors in one hour, as an absolute moment.
 *
 * Not a weekday-and-hour pair, which is what the grid draws: that shape can
 * only be built where somebody's timezone is known, and the server is the one
 * place it is not. "3am" has to mean the hour the reader was asleep, so the
 * bucketing into days and hours happens in the browser.
 */
export interface MonitorHeatCell {
  /** Start of the hour, epoch ms, UTC. */
  at: number
  count: number
}

/** The bar, and the numbers that explain it. */
export interface MonitorUptimeSummary {
  days: MonitorUptimeDay[]
  /** New issues across the window, ignored ones excluded. */
  newIssues: number
  /** Requests that failed over requests served. */
  errorRate?: number
  calmDays: number
  /** Days with any data at all — the denominator `calmDays` is out of. */
  measuredDays: number
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
   * When somebody last claimed this was fixed. Absent if nobody ever has.
   *
   * Kept after the issue reopens, which is the point: `resolved` is a boolean
   * and flipping it back to false erased the fact that a claim was made at
   * all — so the most valuable thing this tool can say, that a fix did not
   * hold, was invisible everywhere outside a single alert.
   */
  resolvedAt?: number
  /**
   * When it happened again after being resolved. Absent unless it did.
   *
   * With `resolvedAt`, this is the whole story: a regression an hour after the
   * fix is a bad fix, one three weeks later is a different problem wearing the
   * same fingerprint.
   */
  regressedAt?: number
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
  /** Endpoint, page or asset. See `MonitorEvent.kind`. */
  kind?: MonitorRouteKind
  /** Raised by `exception()` rather than caught. */
  manual?: boolean
  /** Only ever set on a manual report. */
  level?: MonitorLevel
  group?: string
}
