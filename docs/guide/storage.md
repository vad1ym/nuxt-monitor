# Storage

One SQLite file at `.monitor/monitor.db`, opened once per process. Nothing else: no
external database, no message queue, no agent.

## It stays off the request path

`node:sqlite` is synchronous, so inserting when the error happens would put an
fsync between the failure and the response — an error storm would then slow
down the very application it is reporting on.

Instead, events land in memory and are flushed together inside one
transaction, every second or every hundred events. Request counters are
aggregated the same way, because incrementing per request would put a write on
the hot path of *every* request rather than just the failing ones.

The database runs in WAL mode with `synchronous = NORMAL`, so the dashboard can
read while collection keeps writing, and a durability window on power loss is
traded for far fewer fsyncs — the right side of that trade for error telemetry.

## Four bounds, because one is not enough

| Option | Bounds | Default |
| --- | --- | --- |
| `retentionDays` | Age | 14 |
| `maxEventsPerIssue` | Occurrences kept within one issue | 100 |
| `maxIssues` | Number of distinct issues | 5000 |
| `maxDatabaseMb` | Bytes | 256 |

Age alone does not bound a table that grows with the number of distinct
fingerprints rather than with time. A message carrying text that normalisation
cannot strip gives every occurrence its own fingerprint, so 20,000 such errors
become 20,000 issues — measured at 6.4 MB, growing with traffic rather than
with the size of your application. That is what `maxIssues` and
`maxDatabaseMb` are for.

Eviction is by staleness, then by rarity, resolved issues first: an issue
nobody has seen lately that happened twice is the safest thing to lose, and a
frequent recent one is what somebody is most likely looking for.

::: info Bytes means bytes in use, not the size of the file
SQLite keeps emptied pages on a freelist and reuses them, so a file that once
spiked stays large on disk while holding very little. Measuring the file would
leave the ceiling permanently exceeded after one spike, with no amount of
deleting able to move it. Freed pages are returned to the filesystem with
`incremental_vacuum`.
:::

### A ceiling that is too low

If `maxDatabaseMb` is below what your traffic produces, the most recent 200
events survive anyway and the condition is reported — in the log and as a
banner on the dashboard.

Emptying the database to chase an impossible limit would leave a dashboard
showing no errors, which reads as "nothing is wrong" rather than "the limit is
too low". That is the most misleading state a monitoring tool can be in.

## When the database cannot be opened

A read-only volume, a full disk, a container image where the storage directory
is not writable — opening SQLite can fail for reasons that have nothing to do
with your application.

It used to fail while the Nitro plugin was being registered, outside any
handler, so the module took down the application it exists to watch. Now a
failed open swaps in a store that silently does nothing: collection stops, the
dashboard shows an empty database and explains why, and the application serves
traffic. Losing error reports is a bad day; refusing to boot is an outage.

The same principle applies while running. If writes start failing, batches are
retried with a backoff, and past a bound the oldest are dropped and the loss is
counted. A monitoring tool may lose data; it may not exhaust the heap of the
application it monitors.

## Checking on it

```
GET /_monitor/api/health
```

```json
{
  "enabled": true,
  "bytes": 4194304,
  "maxBytes": 268435456,
  "overCeiling": false,
  "pending": 0,
  "dropped": 0,
  "retryAfter": 0,
  "issues": 42,
  "events": 1503
}
```

`enabled: false` comes with a `reason`. A `pending` count that stays above zero
means flushes are failing; `dropped` confirms it. The dashboard shows all of
this as a banner and says nothing while there is nothing to say.

The endpoint sits behind the session like every other dashboard route — it
names the storage path and describes the deployment.

## Backing it up

It is one file. Copy it, or don't — it holds error reports, not your data.
Deleting `.monitor` loses your history and nothing else; the module recreates it
on the next start.
