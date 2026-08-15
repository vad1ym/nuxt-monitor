# Configuration

Every option has a working default. The only one you have to think about is the
password.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-monitor'],

  monitor: {
    auth: { passwordHash: process.env.MONITOR_PASSWORD_HASH },
    release: process.env.npm_package_version,
  },
})
```

## enabled

`boolean`, default `true`

Master switch. `false` registers nothing — no hooks, no routes, no database.

## route

`string`, default `'/_monitor'`

Where the dashboard and its API are mounted. The boundary is a path segment, so
a route of your own at `/_monitoring` is unaffected.

## storageDir

`string`, default `'.monitor'`

Directory for the SQLite file and the sourcemap archive, relative to your
project root. Add it to `.gitignore`.

## databaseUrl

`string`, default `''` (SQLite under `storageDir`)

Connection string for an external database. Install the matching driver; it is
loaded only when a url asks for it.

| Scheme | Engine | Driver |
| --- | --- | --- |
| `postgresql://`, `postgres://` | PostgreSQL | `pg` |
| `mysql://`, `mariadb://` | MySQL, MariaDB | `mysql2` |

An unknown scheme throws at start-up rather than falling back to SQLite — an
app that runs while writing its errors somewhere you did not configure is worse
than one that refuses to start.

[`maxDatabaseMb`](#maxdatabasemb) does not apply here; see
[Storage](../guide/storage#using-an-external-database).

## auth

See [Authentication](../guide/authentication).

| Option | Type | Default |
| --- | --- | --- |
| `auth.username` | `string` | `'admin'` |
| `auth.password` | `string` | — |
| `auth.passwordHash` | `string` | — |
| `auth.secret` | `string` | derived from the password |
| `auth.sessionTtl` | `number` (seconds) | `604800` (7 days) |
| `auth.optional` | `boolean` | `true` in dev, always `false` in production |

`passwordHash` wins over `password` — produce one with `npx monitor
hash-password`. Changing the password invalidates every session, unless you set
`secret` yourself.

`auth.optional` serves the dashboard without a password in development. It is
resolved at build time and discarded in a production build, so leaving it in a
config file cannot open a deployed dashboard.

## release

`string`, default `''`

Version recorded on every event, so an incident starts from *appeared in 1.4.0*
rather than a timestamp somebody matches against a deploy log.

Setting it is what turns three things on:

- **Deploy markers** on the Overview chart — a dashed line where each release
  first appeared, so "the errors started after the deploy" is something you can
  see rather than reconstruct.
- **Introduced in 1.8.1 → 1.8.2** on an issue, which says whether a deploy
  caused it and whether the next one stopped it.
- **Issues that first appeared** in a release, which separates "this release is
  noisy" from "this release introduced something".

```ts
monitor: { release: process.env.GIT_SHA }
```

Without it every event carries the same unknown release and none of the above
appears — correctly, since the module was never told when anything shipped.

Read at **build time**, so the value describes the build it is stamped into.
Unset, it falls back to `NUXT_MONITOR_RELEASE`, then to whatever SHA your CI
exposes — `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`,
`COMMIT_REF`. A 40-character SHA is shortened to seven; strings are capped at 64.

Sourcemaps survive a deploy whether or not you set this — the archive is keyed
by build. See [Sourcemaps](../guide/sourcemaps#across-deploys).

::: warning A release set on the server overrides the client's
`NUXT_MONITOR_RELEASE` in the server environment applies to client events too.
Do not set it at runtime if you report different releases from browser and
server.
:::

## retentionDays

`number`, default `14`

How long events are kept. Applied at start-up and every six hours. Request
counters are kept three times longer.

## maxEventsPerIssue

`number`, default `100`

Occurrences stored per issue, oldest evicted first. The issue's own count keeps
counting past what it stores.

## maxIssues

`number`, default `5000`

Ceiling on distinct issues; stale and rare ones go first, resolved before that.
See [why this axis runs away](../guide/grouping#when-grouping-is-wrong).

## maxDatabaseMb

`number`, default `256`

Ceiling on stored bytes, measured as pages in use rather than file size. `0`
disables it. The most recent 200 events survive whatever you set. SQLite only —
see [Storage](../guide/storage).

## keepSourcemapBuilds

`number`, default `5`

How many builds' sourcemaps to keep, newest first. Maps are large — this is a
disk budget, not a retention policy. `0` keeps none.

Renamed from `keepSourcemapsFor`, which read as a duration when the value is a
count of builds. The old name still works and warns at build time.

## scrubKeys

`string[]`, default `[]`

Extra key patterns to redact, on top of the built-in set. Substring match,
case-insensitive. See [Privacy](../guide/privacy).

## capture

What of the failing request to keep beside the stack.

| Option | Type | Default |
| --- | --- | --- |
| `capture.request` | `boolean` | `false` |
| `capture.response` | `boolean` | `true` |
| `capture.maxBytes` | `number` | `8192` |
| `capture.environment` | `boolean` | `false` |

A stack says where the code broke; a body says what broke it. "Cannot read
properties of undefined" is one bug or fifty depending on what was posted.

### What the browser records anyway

Every client error already carries the conditions it happened under: the
viewport it was rendered at, whether the browser thought it had a network, the
connection class it reported, and the host a visitor arrived from — the host
only, never the full referring URL. None of it singles anybody out, and each of
them is regularly the whole explanation: a layout that only breaks below a
breakpoint, a request that failed because a train entered a tunnel.

### `capture.environment`

Adds the browser's locale, time zone, screen size, pixel ratio and JS heap
usage to client errors.

Off by default, and not because the values are useless — a date that formats
wrongly, a layout that breaks at one screen size and a tab that dies of memory
pressure are each close to unreproducible without them.

Off because of what they are *together*. Locale, time zone and exact screen
geometry are the classic ingredients of a browser fingerprint: individually
ordinary, jointly identifying enough to recognise a visitor across sessions.
Everything this module collects by default is deliberately not that — see
[Privacy](/guide/privacy) — so turning this on is a decision your application
makes about its own users, not a default that quietly changes what the tool is.

The response half is on: your application wrote it, and for a failure it is
usually the error envelope you would have asked for first. The request half is
off, because that is where passwords and card numbers live — turn it on
deliberately, having thought about what your endpoints receive.

Only failures are read. A successful request is never touched, so this cannot
become a log of everything your users typed. Both halves are truncated past
`maxBytes` with a marker, and go through the same redaction as everything else
— which matches *keys*, so a token inside a field called `data` survives it.
That is the reason for the default.

```ts
capture: { request: true }
```

## ignore

What never reaches the database. Filtering on the way in, because noise that is
stored still costs disk and still dilutes the counts.

| Option | Type | Default |
| --- | --- | --- |
| `ignore.statuses` | `number[]` | `[404, 429]` |
| `ignore.messages` | `string[]` | `[]` |
| `ignore.routes` | `string[]` | `[]` |
| `ignore.types` | `string[]` | `[]` |

A 404 says a client asked for something that is not there, and a 429 is your
rate limiter working — neither is a fault in your application. Set
`statuses: []` to record them anyway.

The rest of the 4xx range **is** recorded. It used to be dropped wholesale, and
that hid real bugs: a 422 raised by a page's own `$fetch` — a `null` reaching an
API that rejects it — takes the page down and never appears here. The bias is
towards recording, because a missed error costs an afternoon and an extra row
costs one click on Ignore. Messages and
routes match as substrings or `/regex/` strings.

```ts
ignore: {
  messages: ['ResizeObserver loop', '/^Loading chunk \\d+ failed/'],
  types: ['AbortError'],
}
```

## notifications

Where alerts go, and what is worth one. Off until a channel is configured. See
[Notifications](../guide/notifications).

| Option | Type | Default |
| --- | --- | --- |
| `notifications.enabled` | `boolean` | `true` once a channel exists |
| `notifications.channels` | `channel[]` | `[]` |
| `notifications.dashboardUrl` | `string` | — |
| `notifications.cooldownMinutes` | `number` | `60` |
| `notifications.groupWindowSeconds` | `number` | `30` |
| `notifications.triggers.newIssue` | `boolean` | `true` |
| `notifications.triggers.regression` | `boolean` | `true` |
| `notifications.triggers.thresholds` | `number[]` | `[10, 100, 1000]` |
| `notifications.triggers.spike` | `boolean \| { factor?, minimum? }` | `false` |
| `notifications.triggers.errorRate` | `number \| { above, minimumRequests? }` | `false` |
| `notifications.triggers.silence` | `boolean \| { after? }` | `false` |
| `notifications.quietHours` | `{ from, to, timezone?, days? }` | — |

A channel is one of:

| Type | Fields |
| --- | --- |
| `telegram` | `token?`, `chatId?` |
| `slack` | `webhookUrl?`, or `token?` with `channel?` |
| `webhook` | `url?`, `headers?` |

Each also takes an optional `name` for the delivery log and `enabled: false` to
keep it configured but silent. A Slack channel given both a `webhookUrl` and a
`token` uses the hook — it already names its destination, so honouring both
would post the same alert twice. Leave the
credentials off and supply them through the environment — see
[Secrets](../guide/notifications#secrets) for why that is not just a preference.

A channel may also narrow what it receives: `groups: ['payments']` restricts it
to those [priority groups](../guide/reporting#groups) — and therefore to manual
reports only — and `minLevel: 'critical'` sets a severity floor.

```ts
notifications: {
  // Credentials come from the environment at runtime — a token written here is
  // resolved at build time and ends up in the build output.
  channels: [{ type: 'telegram' }],
  dashboardUrl: 'https://app.example.com/_monitor',
  quietHours: { from: '22:00', to: '07:00', timezone: 'Europe/Kyiv' },
}
```

`cooldownMinutes` is the number that decides whether this feature is usable: it
is one message per issue per hour rather than one per occurrence. `dashboardUrl`
must be absolute — alerts are raised from background flushes, where there is no
request to derive a host from.

### The three that are off by default

`newIssue`, `regression` and `thresholds` watch one issue at a time and are on
because they cannot be noisy: each fires on a fact about a single fingerprint.
The three below answer questions those cannot, and each needs a decision from
you before it is safe to enable.

```ts
notifications: {
  triggers: {
    spike: true,            // or { factor: 5, minimum: 10 }
    errorRate: 0.25,        // or { above: 0.25, minimumRequests: 20 }
    silence: true,          // or { after: 2 * 60 * 60 * 1000 }
  },
}
```

**`spike`** — an issue running far faster than it used to. `true` means five
times its established rate. Thresholds cannot express this: an issue ticking
along at two an hour for a week that suddenly does four hundred in a minute
crossed 100 and 1000 long ago, so nothing is said at exactly the moment
something changed. Needs history to compare against, and ignores a handful of
occurrences — ×180 from three events is arithmetic, not a finding.

**`errorRate`** — the share of requests that failed, application-wide. The only
trigger here that fires when no single issue is remarkable: fifty different
faults each too small to alert on still add up to a checkout nobody can
complete. Measured against requests served, so `minimumRequests` keeps it quiet
on a quiet night — three failures out of four requests at 4am is not an outage.

**`silence`** — nothing reported at all for `after` (two hours by default). The
only one that fires on an *absence*, and the one that decides whether any of the
others can be trusted: a collector that has died produces perfect silence, and
silence reads exactly like a healthy afternoon. Compared against this
application's own history, so a tool that normally sees four requests an hour
has not broken by seeing none for twenty minutes. Keep `after` well above a
deploy's restart window, or every deploy raises one.

## sampling

What to store when one issue is happening constantly. Off by default — on an
ordinary application every occurrence fits, and storing all of them is strictly
better.

| Option | Type | Default |
| --- | --- | --- |
| `sampling.burst` | `number` | `0` (off) |
| `sampling.keepOneIn` | `number` | `20` |
| `sampling.windowMs` | `number` | `60000` |

```ts
// Store the first 20 occurrences of an issue each minute, then one in 20.
sampling: { burst: 20 }
```

Turn it on when a single failing route can outproduce everything else. The
fiftieth identical stack in a minute carries nothing the first ten did not, but
it costs the same to write and pushes other events out of the shared buffer.

**Counts stay exact.** Occurrences that are not stored are still counted, so an
issue never under-reports how often it happened, alert thresholds fire on the
true number, and `last seen` keeps moving. Only the bodies — stack, context,
breadcrumbs — are thinned. The issue card says `last 12 of 40,000` rather than
pretending the history is complete.

Measured on 10,000 events in one process: 290 ms to write with sampling off
against 31 ms with `burst: 20`, and the count still totalling exactly 10,000.

This is a different bound from [`maxEventsPerIssue`](#maxeventsperissue), which
trims *after* the write. Both are useful: this one saves the work, that one
bounds the result.

## groups

Named parts of the application, assigned by rule. See
[Reporting by hand](../guide/reporting#groups-without-touching-the-code).

| Option | Type | Meaning |
| --- | --- | --- |
| `groups.<name>.routes` | `string[]` | Path globs. `**` spans separators, `*` does not, `:param` is one segment |
| `groups.<name>.messages` | `string[]` | Substrings or `/regex/`, as in `ignore` |
| `groups.<name>.notify` | `boolean` | Alert whenever this group fails. Default `false` |

```ts
groups: {
  payments: { routes: ['/api/checkout/**'], notify: true },
  checkout: ['/checkout/**'],
  'third-party': { messages: ['stripe'] },
}
```

A bare array is shorthand for `{ routes: [...] }`. Rules match pages as readily
as endpoints, and the first rule declared wins when two would match.

## Environment variables

Options live under `runtimeConfig.monitor`, so any of them can be overridden at
start-up by the matching `NUXT_MONITOR_*` variable, with nesting spelled as `_`.

| Variable | Effect |
| --- | --- |
| `NUXT_MONITOR_AUTH_PASSWORD` | Password |
| `NUXT_MONITOR_AUTH_PASSWORD_HASH` | Hash |
| `NUXT_MONITOR_AUTH_SECRET` | Session signing secret |
| `NUXT_MONITOR_STORAGE_DIR` | Storage directory |
| `NUXT_MONITOR_DATABASE_URL` | External database |
| `NUXT_MONITOR_RETENTION_DAYS` | Retention window |
| `NUXT_MONITOR_NOTIFICATIONS_DASHBOARD_URL` | Where alert links point |
| `NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_TOKEN` | Telegram bot token |
| `NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_CHAT_ID` | Telegram chat id |
| `NUXT_MONITOR_NOTIFICATIONS_SLACK_WEBHOOK_URL` | Slack incoming webhook URL |
| `NUXT_MONITOR_NOTIFICATIONS_SLACK_TOKEN` | Slack bot token |
| `NUXT_MONITOR_NOTIFICATIONS_WEBHOOK_URL` | Webhook URL |

These are read when the server starts, which is what makes one build deployable
to several environments.

`NUXT_MONITOR_RELEASE` is the exception: it is read at **build time**, because a
release describes the build it is stamped into.
