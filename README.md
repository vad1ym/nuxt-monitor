# nuxt-monitor

[![npm](https://img.shields.io/npm/v/nuxt-monitor?color=1a7f5a)](https://www.npmjs.com/package/nuxt-monitor)
[![CI](https://github.com/vad1ym/nuxt-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/vad1ym/nuxt-monitor/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/nuxt-monitor?color=1a7f5a)](./LICENSE)
[![node](https://img.shields.io/node/v/nuxt-monitor?color=1a7f5a)](https://nodejs.org)

Local-first error monitoring for Nuxt. No DSN, no account, no sourcemap upload.

It runs inside your app, stores errors in a SQLite file next to it, and reads
sourcemaps straight off the disk they were built onto. There is no service to
sign up for and nothing leaves the machine.

![The overview: error rate, errors over time, the biggest contributor, and routes ranked by failure rate](https://raw.githubusercontent.com/vad1ym/nuxt-monitor/main/docs/media/overview.png)

```bash
pnpm add nuxt-monitor
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-monitor'],

  monitor: {
    auth: { password: process.env.MONITOR_PASSWORD },
  },
})
```

The dashboard is at `/_monitor`.

Fuller documentation lives in the repository under `docs/`; `pnpm docs:dev`
serves it locally.

## The point

A stack trace against a minified bundle names `Cn7cGL6M.js:1`, which tells you
nothing. The same error here resolves to the line that threw, with the code
around it — and the framework frames folded away, because they are never what
you are looking for.

![A client TypeError resolved to client-error.vue line 33, showing the failing line in context with six Vue frames collapsed](https://raw.githubusercontent.com/vad1ym/nuxt-monitor/main/docs/media/issue.png)

Every issue is also broken down by browser, OS, device, release, route and
session. "33 errors" is a number; "33 errors, and 42% of them Chrome" is where
you start looking.

![The same issue broken down by browser, browser version, OS and OS version, each as a ranked bar with percentages](https://raw.githubusercontent.com/vad1ym/nuxt-monitor/main/docs/media/breakdown.png)

Server and client errors land in one list, filterable by side, browser, OS and
device — with query strings redacted before they are ever written down.

![The issue list showing server and client issues together, each with its type, resolved file, route and HTTP status](https://raw.githubusercontent.com/vad1ym/nuxt-monitor/main/docs/media/issues.png)

> The screenshots come from the example app in this repository. `pnpm demo`
> builds it, starts it, and fills it with real errors from code that actually
> threw.

## What it does

- **Collects both sides.** One Nitro `error` hook catches every server path —
  handlers, plugins, cached functions, unhandled rejections — and a client
  plugin catches what happens in the browser, including errors after hydration.
- **Resolves stack traces to source**, with the failing line and the lines
  around it. Maps are read from disk, so they cannot drift out of sync with the
  build that produced the error, and they are never served to the public.
- **Groups occurrences into issues** by side, type, normalised message and the
  first frame in your own code — so a message carrying an id does not become a
  thousand separate issues.
- **Breaks an issue down** by browser, OS, device, release, route and session.
  "250 errors" is a number; "250 errors, all Safari 16" is a diagnosis.
- **Redacts as it collects.** Authorization headers, cookies, passwords and
  tokens never reach the database.

## Configuration

Every option has a working default. The only one you have to think about is the
password.

```ts
monitor: {
  enabled: true,             // master switch
  route: '/_monitor',           // where the dashboard is mounted
  storageDir: '.monitor',       // database and sourcemap archive, relative to root

  auth: {
    username: 'admin',
    passwordHash: '…',       // preferred; see below
    password: '…',           // convenient in dev
    sessionTtl: 604800,      // 7 days
  },

  release: '',               // stamped on every event; see Releases
  retentionDays: 14,
  maxEventsPerIssue: 100,
  maxIssues: 5000,
  maxDatabaseMb: 256,
  keepSourcemapsFor: 5,      // builds whose maps are kept

  scrubKeys: [],             // extra keys to redact
  ignore: {
    statuses: [/* every 4xx by default */],
    messages: [],
    routes: [],
    types: [],
  },
}
```

### Authentication

Without a password the dashboard answers `404` — not `403`, which would confirm
there is something there. Errors are still collected either way.

Keep the plaintext out of your config and your build output:

```bash
npx monitor hash-password
# → scrypt$16384$8$1$…
```

```ts
monitor: { auth: { passwordHash: process.env.MONITOR_PASSWORD_HASH } }
```

`NUXT_MONITOR_AUTH_PASSWORD` works too, read when the server starts rather than
when it is built — which is what you want when the same build is deployed to
more than one environment.

### Releases

A release answers the first question of any incident: when did this start?

```ts
monitor: { release: process.env.npm_package_version }
```

Read at build time, so it describes the build it is stamped into. Falls back to
`NUXT_MONITOR_RELEASE` and then to whatever commit SHA your CI exposes
(`GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `COMMIT_REF`).

Every build also files a copy of its sourcemaps beside the database, so a trace
from the version you just replaced still resolves to source. Without that, each
deploy would blind you to the errors still arriving from the build being
retired.

## Storage

One SQLite file under `storageDir`, bounded four ways: by age
(`retentionDays`), by occurrences within an issue (`maxEventsPerIssue`), by
number of issues (`maxIssues`), and by bytes (`maxDatabaseMb`). The last one
matters more than it sounds — a message carrying text that normalisation cannot
strip gives every occurrence its own fingerprint, and that grows with traffic
rather than with the size of your app.

Writes are buffered and flushed in batches, so an error storm never puts an
fsync on a request path. If the database cannot be opened at all — read-only
volume, full disk — collection turns itself off and the application keeps
serving. A monitoring module must never be the reason you are down.

`GET /_monitor/api/health` reports whether collection is running, how much is
stored, and what has been dropped. The dashboard shows it as a banner, because
an empty issue list looks the same whether nothing broke or nothing was
recorded.

## What it is not

- **Not for multiple instances.** The database is per-process, so each replica
  has its own. Behind a load balancer you get a partial view from whichever one
  you reach.
- **Not for serverless.** SQLite on an ephemeral filesystem loses everything
  when the instance goes away.
- **Not a replacement for a hosted service** if you need alerting, retention in
  years, or one view across many applications.

It is for the case those tools handle badly: one app, one server, errors you
want to read now, on infrastructure you already have.

## Requirements

Node 22.13 or newer — `node:sqlite` landed in 22.5 but stayed behind
`--experimental-sqlite` until 22.13. Nuxt 4.

## License

MIT
