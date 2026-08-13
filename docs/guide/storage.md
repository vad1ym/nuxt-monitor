# Storage

One SQLite file at `.monitor/monitor.db`, opened once per process. Nothing to
run, no queue, no agent. Point [`databaseUrl`](../config/#databaseurl) at
PostgreSQL or MySQL when one file per process is not what you want.

## It stays off the request path

Events land in memory and are flushed together in one transaction, every second
or every hundred events. Request counters are aggregated the same way. `capture`
is synchronous and returns before anything is written, so neither the error hook
nor the ingest handler ever waits on the database.

On SQLite that is WAL mode with `synchronous = NORMAL`: the dashboard reads
while collection writes, trading a durability window on power loss for far fewer
fsyncs.

## Using an external database

```bash
NUXT_MONITOR_DATABASE_URL=postgresql://user:pass@host/monitor
```

Install `pg` or `mysql2` and the schema is created on first use. Two things
change:

- **`maxDatabaseMb` stops applying** — it counts pages through a SQLite PRAGMA.
  `retentionDays` and `maxIssues` still bound growth.
- **The one-instance limit lifts** — replicas can share one database, and the
  dashboard shows all of them rather than whichever you reached.

Everything else works the same.

## Four bounds

| Option | Bounds | Default |
| --- | --- | --- |
| `retentionDays` | Age | 14 |
| `maxEventsPerIssue` | Occurrences within one issue | 100 |
| `maxIssues` | Distinct issues | 5000 |
| `maxDatabaseMb` | Bytes (SQLite only) | 256 |

Age alone is not enough. A message carrying text that normalisation cannot strip
gives every occurrence its own fingerprint, so 20,000 such errors become 20,000
issues — growing with traffic rather than with the size of your application.
That is what `maxIssues` and `maxDatabaseMb` are for.

Eviction is by staleness, then rarity, resolved issues first.

::: info Bytes means pages in use, not file size
SQLite keeps emptied pages on a freelist, so a file that once spiked stays large
while holding very little. Measuring the file would leave the ceiling
permanently exceeded with no amount of deleting able to move it.
:::

If `maxDatabaseMb` is below what your traffic produces, the most recent 200
events survive anyway and the condition is reported in the log and on the
dashboard. An empty dashboard reads as "nothing is wrong" rather than "the limit
is too low".

## Not writing it in the first place

All four bounds above evict *after* the fact. They bound the database, which is
necessary and not sufficient: a route failing on every request still pays the
full cost of recording each occurrence, still pushes every other event out of
the shared buffer, and is then trimmed away anyway.

[`sampling`](../config/#sampling) decides at the door instead:

```ts
// The first 20 occurrences of an issue each minute, then one in 20.
sampling: { burst: 20 }
```

Off by default. On an ordinary application everything fits, and storing all of
it is strictly better.

**The counts stay exact.** This is the part that makes sampling safe to turn on:
occurrences that are not stored are still counted, so an issue never
under-reports how often it happened, alert thresholds fire on the true number,
and `last seen` keeps moving while a fault is ongoing. Under-reporting would be
worse than not recording at all — "12 occurrences" reads as a curiosity where
40,000 reads as an emergency.

What you lose is bodies: the stack, context and breadcrumbs of the occurrences
that were skipped. The issue card already says `last 12 of 40,000`, and the
dashboard shows a note while sampling is dropping anything, so a thin database
never quietly passes for a quiet one.

Measured on 10,000 events: 290 ms to write with sampling off, 31 ms with
`burst: 20`, and the total count still exactly 10,000.

## When the database cannot be opened

A read-only volume, a full disk, a directory that is not writable. A failed open
swaps in a store that does nothing: collection stops, the dashboard explains
why, and the application keeps serving. Losing error reports is a bad day;
refusing to boot is an outage.

While running, failed writes are retried with a backoff; past a bound the oldest
are dropped and the loss is counted.

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
  "issues": 42,
  "events": 1503
}
```

`enabled: false` comes with a `reason`. A `pending` count that stays above zero
means flushes are failing; `dropped` confirms it. The dashboard shows this as a
banner and says nothing while there is nothing to say.

Behind the session like every other dashboard route.

## Backing it up

It is one file. Copy it, or don't — it holds error reports, not your data.
Deleting `.monitor` loses your history and nothing else.

## Testing against real servers

Engine-specific tests are skipped unless a url is given, so `pnpm test` needs no
databases:

```bash
docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=monitor \
  -e POSTGRES_USER=monitor -e POSTGRES_DB=monitor postgres:17-alpine
docker run -d -p 53306:3306 -e MYSQL_ROOT_PASSWORD=monitor \
  -e MYSQL_DATABASE=monitor -e MYSQL_USER=monitor \
  -e MYSQL_PASSWORD=monitor mysql:9.2

MONITOR_TEST_POSTGRES_URL=postgresql://monitor:monitor@localhost:55432/monitor \
MONITOR_TEST_MYSQL_URL=mysql://monitor:monitor@localhost:53306/monitor \
  pnpm test
```
