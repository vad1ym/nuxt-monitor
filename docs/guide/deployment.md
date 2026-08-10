# Deployment

This module is honest about its shape: it is one process writing one file. That
makes it excellent on a server you control and wrong in several other places.
Better to know which you are in before you rely on it.

## A single server

The case this is built for. Nothing to configure beyond a password and a
release.

```bash
NUXT_MONITOR_AUTH_PASSWORD=… node .output/server/index.mjs
```

Keep `.monitor` on a persistent volume — it holds the database and the sourcemap
archive. Both survive deploys precisely because they live outside `.output`.

## Several instances

Each process opens its own database, so each replica sees only its own errors.
Behind a load balancer you get whichever instance your dashboard request landed
on, which is a partial view that does not announce itself as partial.

There is no shared-storage mode. If you run more than one instance and need one
view, this is the wrong tool.

What does work, if you have a reason to accept the trade:

- **Pin the dashboard to one instance** and accept that it reports on that one.
- **Run it on a single instance** — a worker, a cron box, an admin node — that
  handles a representative slice of traffic.

Set `auth.secret` explicitly in either case, or a session issued by one
instance will be rejected by the next.

## Serverless

Do not. SQLite on an ephemeral filesystem loses everything when the instance is
recycled, which on most platforms is constantly. Concurrent lambdas each get
their own database, or worse, fight over one on a network filesystem that does
not support the locking SQLite needs.

The module will *run* — it will not crash, because a database it cannot open
just disables collection — but what you get is not monitoring.

## Behind a proxy

Requests count and rate-limiting use the client address, taken from
`x-forwarded-for` when present. Make sure your proxy sets it, and that only the
proxy can — an address a client can spoof makes rate-limiting decorative.

If your app is mounted under a sub-path, `app.baseURL` is picked up
automatically for sourcemap resolution. A CDN in front of your assets is
handled through `app.cdnURL`.

## Containers

The storage directory has to be writable and should be a volume:

```dockerfile
VOLUME /app/.monitor
```

Without a volume you lose your history on every deploy, and the sourcemap
archive with it — which means traces from the previous release stop resolving,
exactly when you want them.

If the directory is not writable, collection disables itself and logs the
reason. Check `/_monitor/api/health` if the dashboard looks suspiciously quiet.

## Turning it off

```ts
monitor: { enabled: process.env.NODE_ENV !== 'test' }
```

`enabled: false` registers nothing at all — no hooks, no routes, no database.

## A checklist before you rely on it

- A password is set, and the dashboard asks for it.
- A release is set, and the Releases screen shows it.
- `.monitor` is on a persistent volume.
- An error you caused on purpose appears, resolved to source.
- `/_monitor/api/health` says `enabled: true`.
