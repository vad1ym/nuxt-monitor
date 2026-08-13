# The overview

One screen for the question *what is happening to this application*. It used to
be three — an overview, a traffic screen and a statistics screen — and every
question worth asking crossed the boundaries between them: an error count means
nothing without the traffic that produced it.

## Nothing is shown without its denominator

Four hundred errors is a catastrophe on a quiet internal tool and a rounding
error on a busy shop. So every figure here carries what it is a fraction of:

- **Requests** first, because it is the denominator of everything under it.
- **Failure rate** against requests served, not against other errors.
- Each breakdown slice carries its errors *and* its share of counted page
  views, and is ranked by the ratio between them.

That ratio is the number worth reading. A slice marked `6.7×` produced errors
at nearly seven times the rate the rest of your traffic did — that is a finding.
Ranked by count instead, every breakdown would put your most popular browser at
the top, which you already knew.

A slice needs at least twenty page views before its ratio is believed. Without
that floor a browser with three visits and one error reports a lift of two
hundred and tops every list forever.

## Requests and errors share an axis

Deliberately one chart, not two. Errors rising while traffic rises is a busy
afternoon; errors rising against flat traffic is a deploy. Side by side, the
reader has to make that comparison by eye.

## Deploys are drawn on that same axis

A dashed vertical line marks where each release first appeared, labelled with
its name. It is the fastest answer to the question every incident starts with —
did this begin after we shipped something?

On the chart rather than in a list beside it, because the question is about
*shape*: how much was happening before the line against how much after. A table
of deploy times leaves that comparison to memory.

```ts
monitor: { release: process.env.GIT_SHA }
```

Nothing else is needed — no webhook, no CI integration. The mark sits at the
first event carrying that release, which is as close to the deploy as this
module can know without being told; on a busy application that is seconds
later.

What each release *introduced* is spelled out above the chart rather than
hidden behind a hover — a one-pixel dashed line is a poor thing to ask anybody
to find with a mouse.

Without [`release`](../config/#release) set there are no markers, which is the
honest outcome: nothing ever told the module when anything shipped.

An individual issue carries the same fact as a sentence — **introduced in
1.8.1 → 1.8.2** — which also says whether the deploy *after* it stopped the
bleeding. When older occurrences have been trimmed away by
[`maxEventsPerIssue`](../config/#maxeventsperissue) it reads "seen in" instead:
the earliest surviving occurrence is not necessarily where the issue began, and
blaming a release that was innocent is worse than saying less.

## Breakdowns

One block with a tab per dimension, rather than a card each. Four cards showed
two rows apiece and stood two-thirds empty, and comparing across them was work
for the reader; one table fits the three numbers that matter side by side:

| Column | Meaning |
| --- | --- |
| **Requests** | Page views counted for this value |
| **Errors** | Errors attributed to it |
| **Per view** | Errors per page view, with the multiplier against the application average |

The multiplier is the finding, the rate is the severity. A browser at `3×` is
unusual either way, but `3×` of one error in ten thousand and `3×` of one in
five are different afternoons.

Kind, browser, OS and device are on by default; group, release, versions and
route are one click away in the breakdowns menu. A screen that shows everything
shows nothing.

Route, release, kind and group have no audience to compare against — they
describe the request or the code, not the visitor — so those columns read `—`
rather than inventing a baseline.

## Filtering

Clicking any slice narrows the whole screen — every card, the chart and every
other breakdown. The chips at the top show what is applied and remove it.

The two traffic figures are marked **not filtered** while a filter is on, and
that is honest rather than lazy: request counters are aggregates with no
browser or group attached, so there is nothing to narrow them by. Quietly
leaving them looking filtered would be the screen contradicting itself.

## Days

A bar of the last ninety days, deliberately outside the window the rest of the
screen uses — "has this been calm" is a question about months.

| Colour | Meaning |
| --- | --- |
| **Green** | Calm. New issues may have appeared; none in a watched group, and not many |
| **Amber** | A [watched group](./reporting#groups-without-touching-the-code) failed, or several new issues appeared at once |
| **Red** | A great many new issues, or a failure rate that means an outage |
| **Grey** | No data — before the module was installed, or while it was not running |

Ignored issues never count towards any of it: ignoring an issue is the statement
that it is not worth acting on, and a bar that turns amber over dismissed noise
is a bar people stop reading. Grey is not green for the same kind of reason —
"no errors" and "no data" look identical in the database and mean opposite
things.
