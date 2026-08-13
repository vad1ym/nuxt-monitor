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

## Breakdowns

Four are on by default — kind, browser, OS and device — and the rest are one
click away in the breakdowns menu: group, release, browser version, OS version,
route. A screen that shows everything shows nothing, so the others are opt-in
rather than shipped as clutter.

Dimensions with few values are drawn as rings, because the question there is
"is this split even or lopsided". Everything else is a ranked bar list, because
the question there is "which is biggest".

Some dimensions have no audience to compare against: route, release, kind and
group describe the request or the code, not the visitor. Those are ranked on
error share alone and say so rather than inventing a baseline.

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
