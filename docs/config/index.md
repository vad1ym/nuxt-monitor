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

- Type: `boolean`
- Default: `true`

Master switch. `false` registers nothing at all — no hooks, no routes, no
database.

## route

- Type: `string`
- Default: `'/_monitor'`

Where the dashboard and its API are mounted. `/_monitor/` and `_monitor` both mean
the same thing.

The boundary is a path segment, so a route of your own at `/_monitoring` is
unaffected and its errors are still collected.

## storageDir

- Type: `string`
- Default: `'.monitor'`

Directory for the database and the sourcemap archive, relative to your project
root. Resolved to an absolute path at build time, because the process working
directory in production is not necessarily the app root.

Add it to `.gitignore`.

## auth

- Type: `object`

See [Authentication](../guide/authentication) for the full picture.

### auth.username

- Type: `string`
- Default: `'admin'`

### auth.password

- Type: `string`

Plaintext. Convenient in development; in production prefer `passwordHash` so
the secret is not sitting in your config file or your build output.

### auth.passwordHash

- Type: `string`

A scrypt hash from `npx monitor hash-password`. Wins over `password`.

### auth.secret

- Type: `string`

Secret for signing session cookies. Derived from the password when absent,
which means changing the password invalidates every outstanding session.

Set it explicitly if you need sessions to survive a password change, or if you
run more than one instance.

### auth.sessionTtl

- Type: `number` (seconds)
- Default: `604800` (7 days)

## release

- Type: `string`
- Default: `''`, then `NUXT_MONITOR_RELEASE`, then the CI commit SHA

Version of the application, recorded on every event and used to pick the right
sourcemaps after a deploy. Read at build time. See
[Releases](../guide/releases).

## retentionDays

- Type: `number`
- Default: `14`

How long events are kept. Applied at start-up and every six hours. Request
counters are kept three times longer.

## maxEventsPerIssue

- Type: `number`
- Default: `100`

Occurrences kept within one issue, oldest evicted first. The issue's total
count is not affected — it keeps counting past what it stores.

## maxIssues

- Type: `number`
- Default: `5000`

Ceiling on distinct issues. Stale and rare ones are evicted first, resolved
ones before that. See [Grouping](../guide/grouping#when-grouping-is-wrong) for
why this axis is the one that runs away.

## maxDatabaseMb

- Type: `number`
- Default: `256`

Ceiling on stored bytes, measured as pages in use rather than the size of the
file. Oldest events are evicted first. `0` disables it.

The most recent 200 events survive whatever this is set to. See
[Storage](../guide/storage).

## keepSourcemapsFor

- Type: `number`
- Default: `5`

How many builds' sourcemaps to keep, newest first. `0` keeps none, at the cost
of losing older traces on every deploy.

Keyed by build, not by release — a release name is reused across rebuilds, and
keying by it meant one build deleted another's maps.

Maps are large — this is a disk budget, not a retention policy.

## scrubKeys

- Type: `string[]`
- Default: `[]`

Extra key patterns to redact, on top of the built-in set. Matching is
substring-based and case-insensitive. See [Privacy](../guide/privacy).

## ignore

- Type: `object`

What never reaches the database. Filtering on the way in rather than on the way
out: noise that is stored still costs disk, still has to be paged past, and
still dilutes the counts that tell you which fault is spreading.

### ignore.statuses

- Type: `number[]`
- Default: `[400, 401, 402, 403, 404, 405, 406, 408, 409, 410, 422, 429]`

HTTP statuses to skip. Every 4xx by default — a 404 says a client asked for
something that is not there, which is not a fault in your application.

Set to `[]` to record them.

### ignore.messages

- Type: `string[]`
- Default: `[]`

Substrings, or `/regex/` strings.

```ts
ignore: {
  messages: ['ResizeObserver loop', '/^Loading chunk \\d+ failed/'],
}
```

### ignore.routes

- Type: `string[]`
- Default: `[]`

Request paths to skip, as substrings or `/regex/` strings.

### ignore.types

- Type: `string[]`
- Default: `[]`

Error types to skip — `AbortError` for cancelled navigations, for instance.

## Environment variables

Options live under `runtimeConfig.monitor`, so Nuxt's own convention applies: any
of them can be overridden at start-up by the matching `NUXT_MONITOR_*` variable,
with nesting spelled as `_`.

| Variable | Effect |
| --- | --- |
| `NUXT_MONITOR_AUTH_PASSWORD` | Password |
| `NUXT_MONITOR_AUTH_PASSWORD_HASH` | Hash |
| `NUXT_MONITOR_AUTH_SECRET` | Session signing secret |
| `NUXT_MONITOR_STORAGE_DIR` | Storage directory |
| `NUXT_MONITOR_RETENTION_DAYS` | Retention window |

These are read when the server starts, which is what makes one build
deployable to several environments.

`NUXT_MONITOR_RELEASE` is the exception: it is read at **build time**, because a
release describes the build it is stamped into rather than whatever the process
happens to see later.
