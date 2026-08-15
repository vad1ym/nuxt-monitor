# Privacy

A stack trace drags along the request that produced it, and a request carries
headers, cookies and whatever was in the body. This module is built so the
awkward data never arrives.

## Redaction happens on the way in

Values are scrubbed before anything is written — scrubbing on read would leave
the secrets on disk. Any key whose name contains one of these becomes
`[redacted]`:

`authorization`, `cookie`, `set-cookie`, `password`, `passwd`, `secret`,
`token`, `api-key`, `apikey`, `auth`, `session`, `credentials`, `x-csrf-token`

Matching is substring-based and case-insensitive, so `X-Auth-Token`,
`userPassword` and `refresh_token` are all caught. Add your own:

```ts
monitor: { scrubKeys: ['ssn', 'iban', 'internal-user-ref'] }
```

Query strings in captured URLs are scrubbed by the same rules, so
`?token=abc` does not survive in a route.

## Credentials inside the text itself

A key-based rule cannot help when the secret is in a sentence — and error
messages are full of them: `Invalid token: sk_live_4eC39H…` is something
applications write all the time. That text is not just a column, it is the
issue's title, its search text and the body of every alert about it, so a leak
there travels furthest.

Anything matching a known credential format is replaced with a marker naming
what went — `[redacted key]`, `[redacted token]`, `[redacted jwt]` — in
messages, in bodies and in any string under any key. Recognised today: Stripe
and lookalike `sk_live_`/`pk_test_` keys, GitHub `ghp_`/`github_pat_` tokens,
Slack `xox*` tokens, AWS access key ids, `sk-` API keys, JWTs, and
`Bearer <token>`.

The patterns are deliberately narrow. "Long and random" also describes commit
hashes, uuids and stack offsets, and a redacted error nobody can debug is its
own kind of failure — so only shapes that are a credential and nothing else are
matched.

This happens **before** the fingerprint is taken, so two occurrences of one bug
carrying different tokens still group into a single issue rather than splitting
into one issue per secret.

## What is deliberately not collected

**IP addresses.** The one thing here that would be personal data outright.
Addresses are used in memory for rate-limiting the intake endpoint and are
never written to the database — not raw and not hashed. A hashed address is
still personal data: the whole IPv4 space can be hashed on a laptop, so the
digest identifies its subject exactly as well as the address did. Every "how
many people" question on the dashboard is answered by the per-tab session id
instead, which is random and identifies nobody.

**User identity, unless you ask for it.** Nothing here collects an identity on
its own: there is no user id, no email and no account on any event by default,
and no way for one to appear by accident.

There is one deliberate escape hatch, `identify()`, because anonymity cannot
answer the question that decides priority — three affected sessions is one
developer with three tabs open or three customers who cannot check out. It is
opt-in, off until you call it, and what you pass should be an **opaque account
id**, never an email or a name:

```ts
const { identify } = useMonitor()

identify(user.value?.id)   // on sign-in
identify(undefined)        // on sign-out
```

Calling it changes what this tool is. The value lands in a database on your own
disk with no processor agreement behind it, so pass the least identifying thing
that still counts distinct people, and treat the database as holding personal
data from then on. It is held in memory for the life of the tab and never
persisted in the browser, so it cannot outlive the session it describes or be
read back on a later visit.

**Session ids that mean anything.** The `session` facet is random, per browser
tab, kept in `sessionStorage`. It separates "250 errors, 3 sessions" from "250
errors, 250 sessions" and identifies nobody.

## What is collected

- The error type, message and stack.
- The request path, method and status — the **route shape**, not the raw path.
  A breakdown over `/users/1`, `/users/2`, … would have one row per visitor.
- Request headers, scrubbed.
- Browser, browser major version, OS, OS version and device class, parsed from
  the user agent.
- The release.
- The per-tab session id described above.
- How long the failing request had been running, in milliseconds.
- The Node, Nuxt and Nitro versions it was running on — about your server, not
  about whoever made the request.
- A **request id**, to line an error up with your logs and your proxy's. It is
  adopted from `x-request-id`, `x-correlation-id`, `x-amzn-trace-id` or
  `cf-ray` when one of those arrives, and generated otherwise. It is
  per-request, never per-user: it dies with the response, and nothing can be
  joined across two requests with it.
- The **response body** of a failing request, which your application wrote.
- What led up to a browser error: navigations, requests as
  `POST /api/checkout → 500`, and the visible label of what was clicked. No
  input values, no attributes, no page contents — a breadcrumb trail is not a
  session recording.
- The **matched route** a failing request reached — `/api/orders/:id` beside the
  `/api/orders/8412` that was asked for. About your code, not the caller.
- The conditions a browser error happened under: the **viewport** it was
  rendered at, whether the browser reported itself **online**, the
  **connection class** (`4g`, `slow-2g`), and the **host** a visitor arrived
  from. The host only — never the full referring URL, which routinely carries a
  search query or a token.
- The **request body**, but only if you turn it on — see below.
- The browser's **locale, time zone, screen and heap**, but only if you turn
  those on — see below.

Browser fields are recorded for server errors too. A server error on a page
render still happened *to* somebody, and knowing it only breaks on one browser
is as useful there as it is on the client.

## Request bodies are opt-in

`capture.request` is off by default and should stay off unless you have thought
about what your endpoints receive. A request body is where passwords, card
numbers and personal data actually live, and redaction matches *keys* — a token
in a field called `payload` survives it.

When it is on, only failing requests are read, so it cannot become a log of
everything your users typed. Successful requests are counted, never stored.

```ts
// Off, and the default.
capture: { request: false }
```

The response half is on by default because your application produced it rather
than a visitor, and for a failure it is usually an error envelope. Turn it off
the same way if your errors carry data you would rather not keep.

## Locale, time zone and screen are opt-in

`capture.environment` is off by default, and not because the values are
useless. A date that formats wrongly, a layout that breaks at one screen size
and a tab that dies of memory pressure are each close to unreproducible without
them.

It is off because of what they are together. Locale, time zone and exact screen
geometry are the classic ingredients of a browser fingerprint — individually
ordinary, jointly identifying enough to recognise a visitor across sessions.
That is precisely what everything above is designed not to be, and it is the
reason this module can say it collects no personal data and mean it.

```ts
// Off, and the default.
capture: { environment: false }
```

The fields that carry the same debugging weight without the same risk —
viewport, connectivity, the host somebody arrived from — are collected either
way and need no flag.

## Retention

Events are deleted after `retentionDays` (14 by default), and issues left with
no events go with them. Retention runs at start-up and every six hours. Request
counters are kept three times longer.

## If you need to be strict

```ts
monitor: {
  // Nothing beyond the error itself.
  scrubKeys: ['user', 'email', 'name', 'phone', 'address'],
  capture: { request: false, response: false },
  retentionDays: 3,
}
```

And remember where the database lives: `.monitor/monitor.db` is a file on your
server, subject to the same backups as everything else there.
