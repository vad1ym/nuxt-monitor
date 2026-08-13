# Statistics

Everything on the Issues screen answers "what broke". This one answers the
question above it: how has the application been doing, and is anything about
its failures unusual.

## Calm days

A bar of days, one cell each, going back ninety.

| Colour | Meaning |
| --- | --- |
| **Green** | Calm. New issues may have appeared; none was in a watched group, and there were not many |
| **Amber** | Worth a look. A [watched group](./reporting#groups-without-touching-the-code) failed, or several new issues appeared at once |
| **Red** | A bad day. A great many new issues, or a failure rate high enough to mean an outage |
| **Grey** | No data — before the module was installed, or while it was not running |

The question it answers is *did anything happen yesterday that I should have
known about* — not *was the process alive*, which your infrastructure already
tells you and which would cost a database row every minute to duplicate here.

Three deliberate choices behind the colours:

**Ignored issues never count.** Ignoring an issue is the statement that it is
not worth acting on, and a bar that turns amber over noise somebody already
dismissed is a bar people stop reading.

**New means first seen, not last seen.** An issue that has been failing for a
month is not news today, however often it fired.

**Grey is not green.** "No errors" and "no data" look identical in the database
and mean opposite things. A day nothing was recorded for says so.

4xx does not count against the application: a 404 is a client asking for
something absent.

## When errors happen

Hour of the day against day of the week. The one shape a line chart cannot
show — a fault confined to the nightly batch, or to the Monday morning peak, is
a flat unremarkable line and an obvious bright cell.

Read in the server's local zone, so "3am" means the hour the people reading it
were asleep.

## Who is affected

Browser, OS and device, with the number that makes them worth reading: how
**over-represented** each is against the audience.

A slice showing `6.7×` had 6.7 times the share of errors that it has of page
views. That is a finding. Without the comparison, "67% of errors on Chrome"
usually means only that 67% of your visitors use Chrome — which is why every
share here is measured against counted page views rather than against other
errors.

Click a row to open the issue list filtered to it.

If no page views have been counted yet — a fresh install, or an application
with no pages — the columns fall back to shares of errors alone and say so.
