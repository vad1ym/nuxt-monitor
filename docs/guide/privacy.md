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

Browser fields are recorded for server errors too. A server error on a page
render still happened *to* somebody, and knowing it only breaks on one browser
is as useful there as it is on the client.

## Retention

Events are deleted after `retentionDays` (14 by default), and issues left with
no events go with them. Retention runs at start-up and every six hours. Request
counters are kept three times longer.

## If you need to be strict

```ts
monitor: {
  // Nothing beyond the error itself.
  scrubKeys: ['user', 'email', 'name', 'phone', 'address'],
  retentionDays: 3,
}
```

And remember where the database lives: `.monitor/monitor.db` is a file on your
server, subject to the same backups as everything else there.
