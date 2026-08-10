# Coming from Sentry

The two tools answer different questions, and swapping one for the other only
makes sense once you know which you were actually asking.

## What you give up

- **Alerting.** There is no notification of any kind. You look, or you don't.
- **One view across applications.** One database per app, per instance.
- **Long retention.** Days, bounded by disk, not years.
- **Everything around the error** — issue assignment, workflow, integrations,
  performance tracing, release health, cron monitoring, replay.
- **Someone else's uptime.** If your server is down, so is your dashboard.

## What you get

- **No account, no DSN, no upload.** Install the module, set a password.
- **No sourcemap step in your pipeline.** Maps are read off the disk beside the
  running app, so they cannot be stale, mismatched or forgotten.
- **Nothing leaves the machine.** Which for some projects is not a preference
  but a requirement.
- **No cost, and no sampling forced by a quota.**

## Mapping the concepts

| Sentry | nuxt-monitor |
| --- | --- |
| DSN | — nothing to configure |
| Release | [`release`](./releases) |
| Environment | Not modelled; use one install per environment |
| Issue | Issue |
| Event | Occurrence |
| Fingerprint rules | [Automatic](./grouping), not configurable |
| `beforeSend` | [`ignore`](../config/#ignore) and [`scrubKeys`](./privacy) |
| Sourcemap upload | None — maps are read from disk |
| `setUser` | Deliberately absent, see [Privacy](./privacy) |
| Breadcrumbs | Collected on the client |
| Alerts | — |

## Running both

Perfectly reasonable, and often the right answer: Sentry for alerting and
history, this for the fast local loop where you want the failing line without
leaving your own infrastructure.

They do not interfere. Both hook the same Nitro errors, and neither swallows
what the other collects.

## Migration

There is no importer. Historical issues stay in Sentry; this starts collecting
from the moment you install it.

If your Sentry setup relies on custom fingerprinting, check
[Grouping](./grouping) first — grouping here is automatic and cannot be
overridden, which is a real constraint if you have tuned rules you depend on.
