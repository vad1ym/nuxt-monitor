# Getting started

## Requirements

- **Node 22.13 or newer.** `node:sqlite` landed in 22.5 but stayed behind
  `--experimental-sqlite` until 22.13, where `require('node:sqlite')` still
  throws *No such built-in module*.
- **Nuxt 4.**

## Install

::: code-group

```bash [npm]
npm install nuxt-monitor
```

```bash [yarn]
yarn add nuxt-monitor
```

```bash [pnpm]
pnpm add nuxt-monitor
```

:::

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-monitor'],

  monitor: {
    auth: { password: process.env.MONITOR_PASSWORD },
  },
})
```

Start the app and open `/_monitor`. Sign in as `admin` with the password you set.

::: warning Without a password the dashboard does not exist
Every dashboard route answers `404` while no credentials resolve — not `403`,
which would confirm there is something behind it worth attacking. Errors are
still collected, so you can set a password later and find them waiting.
:::

## Check that it works

The fastest confirmation is an error you caused on purpose. Add a route that
throws:

```ts
// server/api/boom.ts
export default defineEventHandler(() => {
  throw new Error('a deliberate failure')
})
```

Request it once, then open the dashboard. You should see one issue, with the
stack resolved to `server/api/boom.ts` and the failing line shown in context.

![The issue list showing server and client issues together, each with its type, resolved file, route and HTTP status](/media/issues.png)

Server and client errors land in one list, filterable by side, browser, OS and
device.

If the issue appears but the frame is not resolved, that is a sourcemap
problem rather than a collection problem — see [Sourcemaps](./sourcemaps).

## What is collected

**Server errors** arrive through Nitro's `error` hook, which every server
failure path funnels through: request and response handlers, plugins, cached
function failures, and the process-level `unhandledRejection` and
`uncaughtException` traps.

**Client errors** arrive through a browser plugin that posts to
`/_monitor/api/ingest`. It listens on Vue's `vue:error` as well as the window
handlers, because Nuxt removes its own Vue error handler once the app
hydrates — anything listening only to `app:error` stops seeing component
errors from that point on.

**Request counts** are recorded as counters — a route shape, a method and a
status class, never bodies, headers or addresses. They exist so an error count
has a denominator: ten failures out of ten requests and ten out of a million
are different situations.

By default every 4xx is ignored. A 404 says a client asked for something that
is not there, which is not a fault in your application and would otherwise
bury the ones that are. See [`ignore`](../config/#ignore) to change that.

## Where the data goes

A single SQLite file at `.monitor/monitor.db`, beside your project. Add it to
`.gitignore`:

```
.monitor
```

Nothing is sent anywhere. There is no account, no DSN and no upload step.
