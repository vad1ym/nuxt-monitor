# Deployment

On SQLite this is one process writing one file — excellent on a server you
control, wrong in a few other places. An external database changes that; see
[Storage](./storage#using-an-external-database).

## A single server

The case this is built for. Nothing to configure beyond a password and a
release.

```bash
NUXT_MONITOR_AUTH_PASSWORD=… node .output/server/index.mjs
```

Keep `.monitor` on a persistent volume — it holds the database and the sourcemap
archive. Both survive deploys precisely because they live outside `.output`.

## Several instances

Point every replica at the same [external
database](./storage#using-an-external-database) and the dashboard shows all of
them:

```bash
NUXT_MONITOR_DATABASE_URL=postgresql://user:pass@host/monitor
```

On SQLite each process opens its own file, so each replica sees only its own
errors — a partial view that does not announce itself as partial.

Either way, set `auth.secret` explicitly, or a session issued by one instance is
rejected by the next.

## Serverless

Not on SQLite: an ephemeral filesystem loses everything when the instance is
recycled, and concurrent lambdas either get their own database each or fight
over one on a filesystem without the locking SQLite needs. The module will run
— an unopenable database just disables collection — but what you get is not
monitoring.

With an external database it works, since nothing is kept on local disk.

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
- `.monitor` is on a persistent volume, or `databaseUrl` points elsewhere.
- An error you caused on purpose appears, resolved to source.
- `/_monitor/api/health` says `enabled: true`.
