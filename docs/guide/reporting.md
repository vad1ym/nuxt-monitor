# Reporting by hand

Not everything worth knowing about throws. A payment that does not reconcile,
an invariant that no longer holds, a third party answering `200` with nonsense
— code like that already has a branch for the bad case. What it lacks is
anywhere to say so.

```ts
// server/api/checkout.post.ts
export default defineEventHandler(async (event) => {
  const charge = await settle(order)

  if (charge.total !== order.total) {
    exception('Charged total does not match the order', {
      level: 'critical',
      group: 'payments',
      meta: { order: order.id, expected: order.total, charged: charge.total },
    }, event)
  }

  return { ok: true }
})
```

The request still succeeds. The mismatch becomes an issue with a fingerprint, a
history and — if a channel is configured — an alert.

In components and other app code, the same thing through a composable:

```vue
<script setup lang="ts">
const { exception } = useMonitor()

function onQuoteMismatch(quote: Quote) {
  exception('Quote changed between steps', { group: 'checkout', meta: { id: quote.id } })
}
</script>
```

Both are auto-imported. Both produce the same event, so where a report was made
from does not change which issue it joins.

## This is not a logger

Every call becomes an issue. That is the point — and the constraint. Things
that happen routinely belong in logs, and putting them here would make the
issue list exactly as skimmable as a log file.

A useful test: if you would not want to be told about it, it does not belong in
`exception()`.

## Levels

`info`, `warning`, `error` (the default) and `critical`. The level is decided
at the call site because that is the only place that knows: whether a
mismatched total is a curiosity or an emergency is not recoverable from the
message afterwards.

It does two things. It colours the row in the dashboard, and it is what a
channel's `minLevel` filters on — so `critical` is the difference between a
line in a chat and somebody's phone at 3am.

## Groups

A group is a named area of concern — `payments`, `data-integrity`, `checkout`.
Free-form on purpose: the set of things worth watching belongs to the
application, not to this module.

Groups do three things:

- **Separate issues.** A group named at the call site is part of the
  fingerprint, so the same sentence reported under `payments` and under
  `data-integrity` is two issues. Naming one is exactly the claim that they are
  different concerns. (A group assigned by a rule is not — see below.)
- **Filter the list.** `?group=payments`, and the Reported scope in the sidebar.
- **Route alerts.** This is the one that pays for the other two.

```ts
notifications: {
  channels: [
    // The payments chat, where the people who can act on it are.
    { type: 'telegram', name: 'payments', groups: ['payments'], minLevel: 'error' },
    // Everything else, including every caught error.
    { type: 'telegram', name: 'engineering' },
  ],
}
```

A channel that names `groups` receives only those groups — and therefore no
caught errors at all, since a caught error has no group. That is deliberate: a
payments channel that also gets every `TypeError` in the application is a
general channel with extra steps. Leave `groups` unset for a channel that
should see everything.

`minLevel` treats a caught error as `error`, so raising the floor to `warning`
does not silently drop genuine exceptions.

### Groups without touching the code

Most errors are not raised by hand, and they deserve a group too: a failure in
`/api/checkout` belongs to payments whether or not anybody called
`exception()`. Rules in the config assign one.

```ts
monitor: {
  groups: {
    payments: { routes: ['/api/checkout/**', '/api/refunds/**'], notify: true },
    // Pages as readily as endpoints — a rule matches any path, and a
    // client-side error carries the page it happened on.
    checkout: { routes: ['/checkout/**', '/cart'] },
    // For the faults a path cannot find: a provider breaks inside your route,
    // not on its own.
    'third-party': { messages: ['stripe', '/timeout of \\d+ms/'] },
  },
}
```

`routes` takes globs — `**` spans separators, `*` does not, `:param` is one
segment — and a trailing `/**` covers the section's own root, so
`/api/checkout/**` includes `/api/checkout`. `messages` takes substrings or
`/regex/`, the same spelling `ignore` uses.

`notify: true` makes the group worth an alert whenever it fails, not only the
first time or on the way past a threshold. It is a trigger like any other and
obeys the same cooldown, grouping window and quiet hours — a watched group is
not a way around the rules that keep alerting bearable.

Two things worth knowing:

- **A group from a rule is not part of the fingerprint.** A group named at the
  call site is — it is the author's claim that two reports are different
  concerns. A rule infers one from a path, so folding it into the identity
  would re-key every existing issue the moment the option is turned on.
- **An explicit group wins.** `exception(…, { group })` is a statement by
  whoever wrote the code; a rule is an inference from a coincidence of path.

Rules are read-only from the dashboard. They describe the architecture of the
application rather than an observation about it, so they belong beside the code
and in review — unlike resolving or ignoring an issue, which is what somebody
concluded this afternoon. The Notifications screen lists them.


## What is stored

The message, the stack of the call site, the level, the group and whatever
`meta` carried. `meta` is scrubbed exactly like any other captured context — a
hand-written report is more likely to hand over a whole object from the
surrounding code, not less, and the same keys are secret wherever they came
from.

The stack starts at your call, not inside nuxt-monitor. That matters more than
it looks: the top application frame is part of the fingerprint, so a stack
beginning in our code would group every manual report in the application into a
single issue.

## In the dashboard

Manual reports sit in the same list as everything else and are marked with a
flag, coloured by level. **Reported** in the filter bar shows only them.

They are shown apart because they answer a different question — "what did
somebody decide was worth watching" rather than "what broke" — and a list that
mixes the two makes the smaller set unfindable.
