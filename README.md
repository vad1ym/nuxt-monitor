# nuxt-monitor

[![npm](https://img.shields.io/npm/v/nuxt-monitor?color=1a7f5a)](https://www.npmjs.com/package/nuxt-monitor)
[![CI](https://github.com/vad1ym/nuxt-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/vad1ym/nuxt-monitor/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/nuxt-monitor?color=1a7f5a)](./LICENSE)
[![node](https://img.shields.io/node/v/nuxt-monitor?color=1a7f5a)](https://nodejs.org)

Local-first error monitoring for Nuxt. No DSN, no account, no sourcemap upload.

Runs inside your app, stores errors in a SQLite file next to it, and reads
sourcemaps off the disk they were built onto. Nothing leaves the machine.

![The overview: error rate, errors over time, the biggest contributor, and routes ranked by failure rate](https://raw.githubusercontent.com/vad1ym/nuxt-monitor/main/docs/media/overview.png)

## Installation

```bash
npm install nuxt-monitor
```

```bash
yarn add nuxt-monitor
```

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

The dashboard is at `/_monitor`. It opens without a password in development; in
production, without one configured it answers `404` — errors are still
collected, so you can set one later and find them waiting.

Requires Node 22.13+ (`node:sqlite`) and Nuxt 4.

## Features

- **Both sides.** A Nitro `error` hook catches every server path — handlers,
  plugins, cached functions, unhandled rejections — and a client plugin catches
  the browser, including errors after hydration.
- **Stack traces resolved to source**, with the failing line in context. Maps
  are read from disk, so they cannot drift out of sync with the build that
  produced the error, and they are never served to the public.
- **Occurrences grouped into issues** by side, type, normalised message and the
  first frame in your own code — so a message carrying an id does not become a
  thousand issues.
- **Breakdown** by browser, OS, device, release, route and session.
- **Alerts to Telegram or a webhook** on a new issue, a regression or an issue
  growing — with a per-issue cooldown, grouping and quiet hours, because the
  version without those is the version people mute on the first day.
- **Redaction on collect.** Authorization headers, cookies, passwords and
  tokens never reach the database.
- **Bounded storage.** One SQLite file, capped by age, count and bytes. If it
  cannot be opened, collection turns itself off and the app keeps serving.
- **Or an external database.** Point `databaseUrl` at PostgreSQL or MySQL when
  one file per process is not what you want.

## Documentation

**[vad1ym.github.io/nuxt-monitor](https://vad1ym.github.io/nuxt-monitor/)** —
or `pnpm docs:dev` to read it locally.

- [Getting started](https://vad1ym.github.io/nuxt-monitor/guide/getting-started)
- [Configuration](https://vad1ym.github.io/nuxt-monitor/config/)
- [Authentication](https://vad1ym.github.io/nuxt-monitor/guide/authentication)
- [Sourcemaps](https://vad1ym.github.io/nuxt-monitor/guide/sourcemaps)
- [Notifications](https://vad1ym.github.io/nuxt-monitor/guide/notifications)
- [Deployment](https://vad1ym.github.io/nuxt-monitor/guide/deployment)

## Limitations

- **One instance on SQLite.** The file is per-process, so each replica has its
  own and you get a partial view behind a load balancer. An external database
  lifts this.
- **Not for serverless on SQLite.** An ephemeral filesystem loses everything
  when the instance goes away; an external database does not.
- **No multi-year retention** or one view across many apps. Alerting covers new
  issues, regressions and growth; alerting on a spike against a baseline does
  not exist yet.

It is for the case those tools handle badly: one app, one server, errors you
want to read now, on infrastructure you already have.

## License

MIT
