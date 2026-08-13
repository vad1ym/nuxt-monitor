# API

The dashboard is a plain SPA talking to these endpoints. They are documented
because you may want to script against them — a deploy check, a status page —
not because they are a stable public contract. Treat them as internal to the
minor version.

All paths are relative to `route` (`/_monitor` by default). Everything except
`POST /api/ingest` and `POST /api/login` requires a valid session cookie, and
answers `404` while no credentials are configured at all.

## POST /api/login

```json
{ "username": "admin", "password": "…" }
```

Sets the session cookie. Answers `401` for a wrong username *or* a wrong
password, with the same message either way — telling the two apart would
confirm a valid username to somebody guessing.

## POST /api/logout

Clears the session. Requires a same-origin `Origin` header.

## POST /api/session

Whether the current cookie is valid.

```json
{ "authenticated": true }
```

## GET /api/overview

The dashboard's front page: error counts by side, issue counts, the request
count they are divided by, a trend series, the worst routes and the most recent
issues.

Query: `hours` (default 24).

## GET /api/issues

The issue list.

| Parameter | Meaning |
| --- | --- |
| `side` | `client` or `server` |
| `resolved` | `true` or `false` |
| `search` | Message, file or route |
| `type` | Error type |
| `limit`, `offset` | Paging |
| Facet names | Repeatable — `?browser=Safari&browser=Firefox` |

```json
{ "issues": [ … ], "total": 128 }
```

## GET /api/issues/:fingerprint

One issue with its recent occurrences, each with its stack **resolved to
source**. Also returns the facet counts for the breakdown, the number of
distinct sessions, and how many occurrences match the filter.

Accepts the same facet parameters, so the breakdown and the occurrences below
it always describe the same slice.

## PATCH /api/issues/:fingerprint

```json
{ "resolved": true }
```

Requires a same-origin `Origin` header. A resolved issue reopens by itself if
it happens again.

## GET /api/facets

Facet counts over a window, for the filter panel.

Query: `window` (milliseconds), plus any facet filters to count within.

## GET /api/stats

Releases, routes, sessions and environments — the four section screens.

Query: `window`, and `section` to fetch just one
(`releases`, `routes`, `sessions`, `environments`).

They share one endpoint because they are read together and describe the same
window; splitting them would mean four round trips and four chances for the
numbers on one screen to disagree about which instant they describe.

## GET /api/health

The collector's own state. See [Storage](../guide/storage#checking-on-it).

## GET /api/notifications

What is configured and what has been sent. See
[Notifications](../guide/notifications).

Query: `limit` (default 100, max 200).

```json
{
  "enabled": true,
  "channels": [{ "name": "ops-chat", "type": "telegram", "enabled": true }],
  "triggers": { … },
  "cooldownMinutes": 60,
  "deliveries": [
    { "id": 41, "at": 1737000000000, "channel": "ops-chat", "reason": "regression",
      "fingerprint": "9f2c…", "alerts": 1, "status": "sent" }
  ]
}
```

Channel names and types only — a token in a response is a token in a browser's
memory and in anything that later reads it.

`status` is `sent`, `failed` with the reason the channel gave, or `suppressed`
with the rule that silenced it. The failures are the point: the question asked
of an alerting system is "why did nobody tell me?", and the answer is never
among the successes.

## POST /api/notifications

Sends a test alert to every configured channel and returns what happened. Takes
no body — what a test sends is not the caller's choice, or the endpoint becomes
a way to post arbitrary text through somebody's bot token.

```json
{ "sent": true, "deliveries": [ … ] }
```

Answers `{ "sent": false, "reason": … }` when no channel is configured.

## POST /api/ingest

The one route without a session — the browser posts here and has no credentials
to offer. It is therefore treated as hostile input:

- **Same-origin only.** A cross-origin post cannot be a genuine report from
  your app, and letting one through would let any site fill your database.
- **Rate limited** to 100 events per address per minute.
- **Bounded body** at 512 KB, checked before anything parses it.
- **Bounded fields**: 20 events per batch, 10 KB per stack, 1 KB per message,
  30 breadcrumbs.

Answers `202` when events were accepted, `413` for an oversized body, `429`
when rate limited, and `204` when it declined for any other reason — a
cross-origin post, an unreadable body, an empty batch. A client cannot act on
a more precise answer, and a precise one would help somebody probing the
limits.
