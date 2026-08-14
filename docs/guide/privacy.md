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

## What is deliberately not collected

**IP addresses.** The one thing here that would be personal data outright.
Addresses are used in memory for rate-limiting the intake endpoint and are
never written to the database.

**User identity.** No user id, no email, no account, and no way to attach one —
a `setUser(email)` field would turn a local debugging tool into a personal data
store you have obligations about.

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
- The **request body**, but only if you turn it on — see below.

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
