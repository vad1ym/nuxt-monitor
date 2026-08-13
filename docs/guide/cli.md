# CLI and export

Your data is in a file you own. That is only worth something if there is a way
out of it, and a way in without a browser.

```bash
npx monitor stats
npx monitor export --format csv > issues.csv
npx monitor purge --days 30 --yes
```

Every command reads `NUXT_MONITOR_DATABASE_URL` and `NUXT_MONITOR_STORAGE_DIR`
when the matching flag is absent, so the same invocation works against SQLite
and against an external database.

## stats

Counts, the span the data covers, and the most frequent issues.

The dashboard answers this better and with context, which is exactly why this
stays a summary rather than growing into a second dashboard. What it is for is
the case where the dashboard is not reachable: a cron box, a container with no
port published, a server somebody is already logged into.

```
  /srv/app/.monitor/monitor.db

  issues       124 (37 open)
  events       8134
  span         2026-07-30T09:12:04.881Z … 2026-08-13T16:44:02.117Z

  Most frequent:
       2841  TypeError: Cannot read properties of undefined
        640  Error: Upstream rejected the request
```

## export

Writes to stdout, so it redirects and pipes.

| Flag | Meaning |
| --- | --- |
| `--table` | `issues` (default) or `events` |
| `--format` | `json` (default) or `csv` |
| `--days` | Only the last N days |

```bash
# Everything, as JSON
npx monitor export --table events > events.json

# Last week's issues, for a spreadsheet
npx monitor export --days 7 --format csv > week.csv
```

The dashboard has the same thing behind a download button
([`GET /api/export`](../config/api#get-api-export)) for when there is a browser
in the loop.

JSON output parses the columns that hold JSON — context, breadcrumbs, tags —
back into structure rather than leaving them as strings. A field that is a
string containing JSON forces every consumer to parse twice, and the second
parse is the one they forget.

::: info CSV cells are defused
A cell beginning `=`, `+`, `-` or `@` is a formula to Excel and Sheets, and
error messages are attacker-influenced text. Those cells are prefixed with an
apostrophe. This is the export of a security tool; handing somebody a
spreadsheet that executes on open would be a poor way to repay them for using
it.
:::

## purge

Deletes events older than `--days`, and the issues left with none.

The server applies `retentionDays` on a timer, so this is for the times that is
not enough: a limit lowered after the fact, a database that grew while nobody
was looking, a copy taken for support that should not keep last month.

```bash
npx monitor purge --days 30        # says what it would delete
npx monitor purge --days 30 --yes  # does it
```

Without `--yes` it only counts. This is the one command here that destroys
anything, and a flag is cheaper than a restore.

## hash-password

```bash
npx monitor hash-password
```

Prints a scrypt hash for `monitor.auth.passwordHash`, so the plaintext never
appears in your config or your build output. Reads from a prompt when no
password is given, which keeps it out of shell history.
