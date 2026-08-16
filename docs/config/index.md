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

## Every option

| Option | Type | Default |
| --- | --- | --- |
| `enabled` | `boolean` | `true` |
| `route` | `string` | `'/_monitor'` |
| `storageDir` | `string` | `'.monitor'` |
| `databaseUrl` | `string` | `''` (SQLite) |
| `release` | `string` | `''` |
| `retentionDays` | `number` | `14` |
| `maxEventsPerIssue` | `number` | `100` |
| `maxIssues` | `number` | `5000` |
| `maxDatabaseMb` | `number` | `256` |
| `keepSourcemapBuilds` | `number` | `5` |
| `scrubKeys` | `string[]` | `[]` |

**Authentication** — see [the guide](../guide/authentication).

| Option | Type | Default |
| --- | --- | --- |
| `auth.username` | `string` | `'admin'` |
| `auth.password` | `string` | — |
| `auth.passwordHash` | `string` | — |
| `auth.secret` | `string` | derived from the password |
| `auth.sessionTtl` | `number` (seconds) | `604800` (7 days) |
| `auth.optional` | `boolean` | `true` in dev, always `false` in production |

**What to keep beside the stack** — see [Privacy](../guide/privacy).

| Option | Type | Default |
| --- | --- | --- |
| `capture.request` | `boolean` | `false` |
| `capture.response` | `boolean` | `true` |
| `capture.maxBytes` | `number` | `8192` |
| `capture.environment` | `boolean` | `false` |

**What never reaches the database.**

| Option | Type | Default |
| --- | --- | --- |
| `ignore.statuses` | `number[]` | `[404, 429]` |
| `ignore.messages` | `string[]` | `[]` |
| `ignore.routes` | `string[]` | `[]` |
| `ignore.types` | `string[]` | `[]` |

**Alerting** — see [Notifications](../guide/notifications).

| Option | Type | Default |
| --- | --- | --- |
| `notifications.enabled` | `boolean` | `true` once a channel exists |
| `notifications.channels` | `channel[]` | `[]` |
| `notifications.dashboardUrl` | `string` | — |
| `notifications.cooldownMinutes` | `number` | `60` |
| `notifications.groupWindowSeconds` | `number` | `30` |
| `notifications.quietHours` | `{ from, to, timezone?, days? }` | — |
| `notifications.triggers.newIssue` | `boolean` | `true` |
| `notifications.triggers.regression` | `boolean` | `true` |
| `notifications.triggers.thresholds` | `number[]` | `[10, 100, 1000]` |
| `notifications.triggers.spike` | `boolean \| { factor?, minimum? }` | `false` |
| `notifications.triggers.errorRate` | `number \| { above, minimumRequests? }` | `false` |
| `notifications.triggers.silence` | `boolean \| { after? }` | `false` |

**Thinning a storm** — see [Storage](../guide/storage).

| Option | Type | Default |
| --- | --- | --- |
| `sampling.burst` | `number` | `0` (off) |
| `sampling.keepOneIn` | `number` | `20` |
| `sampling.windowMs` | `number` | `60000` |
| `sampling.maxTracked` | `number` | `5000` |

**Named parts of the application** — see [Grouping](../guide/grouping).

| Option | Type | Default |
| --- | --- | --- |
| `groups` | `Record<string, string[] \| { routes?, messages?, types?, notify? }>` | `{}` |

## Environment variables

Read when the server starts, which is what makes one build deployable to
several environments. A `NUXT_*` variable overrides the matching config key.

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

::: warning The `NOTIFICATIONS_` segment is not optional
These live under `notifications` in `runtimeConfig`, and Nuxt derives the
variable name from the full path. `NUXT_MONITOR_TELEGRAM_TOKEN` does nothing at
all — the server starts, the channel looks configured, and the first alert is
the one that does not arrive.
:::

`release` also falls back to `NUXT_MONITOR_RELEASE` and then to whatever SHA
your CI exposes — `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`,
`COMMIT_REF`. It is read at **build time**, so the value describes the build it
is stamped into.

## API

Two auto-imported entry points. See [Reporting by hand](../guide/reporting).

```ts
// Anywhere in app code.
const { exception, identify } = useMonitor()

exception('Payment total did not reconcile', {
  level: 'critical',       // 'info' | 'warning' | 'error' | 'critical'
  group: 'payments',
  meta: { orderId },
})

// An opaque account id for this tab's errors. `undefined` clears it.
identify(user.id)
```

```ts
// Server routes, plugins, tasks — `exception` is auto-imported there too.
exception('Stripe answered 200 with an empty body', { group: 'payments' })
```

A CLI ships alongside: `npx monitor stats | export | purge | hash-password`.
See [CLI and export](../guide/cli).

## The options worth a second look

Most of the table above is self-explanatory. These are not.

### `route`

Where the dashboard and its API are mounted. The boundary is a path segment, so
a route of your own at `/_monitoring` is unaffected.

### `databaseUrl`

Install the matching driver; it is loaded only when a url asks for it.

| Scheme | Engine | Driver |
| --- | --- | --- |
| `postgresql://`, `postgres://` | PostgreSQL | `pg` |
| `mysql://`, `mariadb://` | MySQL, MariaDB | `mysql2` |

An unknown scheme throws at start-up rather than falling back to SQLite: an app
that runs while writing its errors somewhere you did not configure is worse than
one that refuses to start. `maxDatabaseMb` does not apply — see
[Storage](../guide/storage#using-an-external-database).

### `release`

Setting it turns on deploy markers on the overview chart, *introduced in
1.8.1 → 1.8.2* on an issue, and the list of issues a release first brought.
Without it every event carries the same unknown release and none of that
appears.

Sourcemaps survive a deploy whether or not you set this — the archive is keyed
by build. See [Sourcemaps](../guide/sourcemaps#across-deploys).

::: warning A release set on the server overrides the client's
`NUXT_MONITOR_RELEASE` in the server environment applies to client events too.
Do not set it at runtime if you report different releases from browser and
server.
:::

### `maxDatabaseMb`

Measured as pages in use rather than file size. `0` disables it. The most recent
200 events survive whatever you set.

### `capture.request` and `capture.response`

The response half is on: your application wrote it, and for a failure it is
usually the error envelope you would have asked for first. The request half is
off, because that is where passwords and card numbers live.

Only failures are read, so this cannot become a log of everything your users
typed. Both halves are truncated past `maxBytes` and go through the same
redaction as everything else — which matches *keys*, so a token inside a field
called `data` survives it. That is the reason for the default.

### `capture.environment`

Adds the browser's locale, time zone, screen size, pixel ratio and JS heap usage
to client errors. Off by default: together those are the classic ingredients of
a browser fingerprint, and everything else this module collects is deliberately
not that. See [Privacy](../guide/privacy#locale-time-zone-and-screen-are-opt-in).

The conditions that carry the same debugging weight without the same risk —
viewport, connectivity, the host somebody arrived from — are recorded either way
and need no flag.

### `ignore`

`statuses` defaults to `[404, 429]`: somebody asking for something absent, and
somebody being rate-limited, are not faults in your code. `messages` and
`routes` take substrings or `/regex/`; `routes` also takes `**` and `:param`
patterns.

```ts
ignore: {
  statuses: [404, 429, 401],
  messages: ['ResizeObserver loop', '/^Loading chunk \\d+ failed/'],
  routes: ['/api/health', '/webhooks/**'],
  types: ['AbortError'],
}
```

### `notifications.triggers`

`newIssue`, `regression` and `thresholds` are on because they cannot be noisy:
each fires on a fact about a single fingerprint. The other three are off and
each needs a decision from you.

```ts
triggers: {
  spike: true,          // or { factor: 5, minimum: 10 }
  errorRate: 0.25,      // or { above: 0.25, minimumRequests: 20 }
  silence: true,        // or { after: 2 * 60 * 60 * 1000 }
}
```

**`spike`** — an issue running five times its established rate. Thresholds
cannot express this: an issue that crossed 100 and 1000 long ago says nothing
when it suddenly does four hundred a minute.

**`errorRate`** — the share of requests that failed, application-wide. The only
trigger that fires when no single issue is remarkable. `minimumRequests` keeps
it quiet on a quiet night.

**`silence`** — nothing recorded at all for `after` (two hours by default). The
only one that fires on an *absence*, and the one that decides whether the others
can be trusted: a dead collector reads exactly like a healthy afternoon. Keep
`after` well clear of a deploy's restart window.

### `sampling`

Off by default; on an ordinary application every occurrence fits. Turn it on
when one failing route can outproduce everything else.

**Counts stay exact.** Occurrences that are not stored are still counted, so an
issue never under-reports how often it happened — only the bodies are thinned.

```ts
sampling: { burst: 20, keepOneIn: 20 }
```

### `groups`

A group labels errors nobody annotated by hand, and is then what an alert
channel subscribes to and what the issue list filters by.

```ts
groups: {
  payments: { routes: ['/api/checkout/**'], notify: true },
  'third-party': ['stripe', 'sendgrid'],
}
```

The array shorthand matches messages. See [Grouping](../guide/grouping).
