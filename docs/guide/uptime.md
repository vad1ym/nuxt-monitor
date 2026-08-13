# Uptime

The one screen that does not answer "what broke". It answers "has this been
reliable" — a question asked over months, which is why it ignores the
dashboard's shared window and always shows ninety days.

## Why it needs a heartbeat

An uptime bar built from errors alone is worse than none, and the reason is
uncomfortable: **a process that is down produces no errors**. Nothing is written
because nothing is running, so the worst possible outage renders as a clean
green day while a busy healthy afternoon renders amber.

So the application writes one row per minute it is alive, on the flush that is
already running. A missing run of minutes is an outage with a beginning, an end
and a duration — a fact, rather than an absence somebody has to interpret.

That is also the limit of what this measures. It is the *application's* view of
itself: if the database is unreachable the beat cannot be written either, and a
machine that never boots reports nothing at all. What it catches is the common
case — a process that crashed, a container that was killed, a deploy that did
not come back — and it catches it honestly.

## What a day can be

| State | Meaning |
| --- | --- |
| **Operational** | Served traffic, and little of it failed |
| **Degraded** | Served traffic, and 5% or more returned 5xx |
| **Down** | Minutes are missing from the heartbeat |
| **No traffic** | Alive, and nothing was asked of it |
| **Not measured** | Before collection started |

Two of those exist to stop the bar from lying in either direction.

**No traffic** is drawn dimly rather than green. A quiet weekend on an internal
tool is not evidence of health, and colouring it as a success would overstate
what the day proves.

**Not measured** is grey rather than red. Installing the module on Tuesday must
not make Monday look like an outage, so availability is measured from the first
heartbeat rather than from the start of the window — and the bar is trimmed to
what was actually observed, so a fresh install shows a few days rather than
eighty-nine grey cells.

4xx is not counted against the application. A 404 says a client asked for
something absent, which is not the same as being down.

A single missing minute is forgiven: a flush can be late and a deploy restarts
the process. A run of them is an incident, and incidents are listed with the
time they started and how long they lasted.

## Retention

Heartbeats are kept ninety days — one small row per minute, about 130,000 rows
at the ceiling — because the bar reaches back that far. Everything else in the
database expires sooner.
