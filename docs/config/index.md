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
rather than a timestamp somebody matches against a deploy log. The Releases
screen counts how many issues **first appeared** in each one, which is what
separates "this release is noisy" from "this release introduced something".

```ts
monitor: { release: process.env.npm_package_version }
```

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

## keepSourcemapsFor

`number`, default `5`

How many builds' sourcemaps to keep, newest first. Maps are large — this is a
disk budget, not a retention policy.

## scrubKeys

`string[]`, default `[]`

Extra key patterns to redact, on top of the built-in set. Substring match,
case-insensitive. See [Privacy](../guide/privacy).

## ignore

What never reaches the database. Filtering on the way in, because noise that is
stored still costs disk and still dilutes the counts.

| Option | Type | Default |
| --- | --- | --- |
| `ignore.statuses` | `number[]` | every 4xx |
| `ignore.messages` | `string[]` | `[]` |
| `ignore.routes` | `string[]` | `[]` |
| `ignore.types` | `string[]` | `[]` |

A 404 says a client asked for something that is not there, which is not a fault
in your application — set `statuses: []` to record them anyway. Messages and
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
| `notifications.quietHours` | `{ from, to, timezone?, days? }` | — |

A channel is `{ type: 'telegram', token, chatId }` or
`{ type: 'webhook', url, headers? }`, each with an optional `name` for the
delivery log and `enabled: false` to keep it configured but silent.

```ts
notifications: {
  channels: [{
    type: 'telegram',
    token: process.env.MONITOR_TELEGRAM_TOKEN!,
    chatId: process.env.MONITOR_TELEGRAM_CHAT!,
  }],
  dashboardUrl: 'https://app.example.com/_monitor',
  quietHours: { from: '22:00', to: '07:00', timezone: 'Europe/Kyiv' },
}
```

`cooldownMinutes` is the number that decides whether this feature is usable: it
is one message per issue per hour rather than one per occurrence. `dashboardUrl`
must be absolute — alerts are raised from background flushes, where there is no
request to derive a host from.

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

These are read when the server starts, which is what makes one build deployable
to several environments.

`NUXT_MONITOR_RELEASE` is the exception: it is read at **build time**, because a
release describes the build it is stamped into.
