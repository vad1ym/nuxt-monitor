# Notifications

Until something tells you an error happened, a monitoring tool only works for
people who remember to open it. This is the part that reaches out.

It is off until you configure a channel.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  monitor: {
    notifications: {
      // No token here — it comes from the environment at runtime. See Secrets.
      channels: [{ type: 'telegram' }],
      dashboardUrl: 'https://app.example.com/_monitor',
    },
  },
})
```

```bash
NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_TOKEN=123456:AA…
NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_CHAT_ID=-1001234567890
```

## Telegram in two minutes

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and keep the
   token it gives you.
2. Send your new bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id` out of
   the response. For a group, add the bot to it first — group ids are negative.
3. Put both in the environment and restart.

Then open the dashboard's Notifications section and send a test. A token and a
chat id copied by hand are wrong often enough that finding out during the first
real incident is not a risk worth taking.

## What raises an alert

Three triggers, all on by default:

| Trigger | Fires when |
| --- | --- |
| `newIssue` | A fingerprint is seen for the first time |
| `regression` | An issue marked resolved happens again |
| `thresholds` | An issue's count crosses `10`, `100` or `1000` |

```ts
triggers: {
  regression: true,
  newIssue: false,
  // An order of magnitude at a time. `[]` turns thresholds off.
  thresholds: [50, 500],
}
```

`regression` is the one worth keeping if you keep only one: somebody said this
was fixed, and it was not. Nothing else in the tool contradicts a human on the
record.

Ignored issues never raise an alert. An issue is ignored *because* it is noisy,
and noisy is what triggers fire on.

## Not becoming the thing people mute

An alerting feature is judged by what it does not send. The first day of noise
is the day somebody mutes the chat, and a muted chat is worse than no alerts —
it looks like coverage.

Three rules stand between an occurrence and a message.

**Cooldown.** After an issue raises an alert, it stays quiet for
`cooldownMinutes` (default 60). An error in a handler under load happens
thousands of times a minute and each occurrence is the same fact. The cooldown
is stored on the issue row, so it survives a restart — which matters, because a
deploy is exactly when alerts fire.

**Grouping.** New alerts wait `groupWindowSeconds` (default 30) so that the four
things one deploy broke arrive as one message about four things. Set `0` to send
each immediately.

**Quiet hours.** A window in which nothing is sent.

```ts
quietHours: {
  from: '22:00',
  to: '07:00',
  timezone: 'Europe/Kyiv',
  // Optional. 0 is Sunday. Omit for every day.
  days: [0, 1, 2, 3, 4],
}
```

Suppressed, not deferred. An alert about a fault that is over by morning is
worth less than the sleep it would have cost, and one about a fault still going
will be raised again by its next occurrence. Suppressed alerts are still written
to the log with the reason, so "did anything happen overnight" has an answer.

Set `timezone` if your server is not in the zone you think in. A server on UTC
and a team that is not makes `22:00` mean the wrong thing by however many hours,
silently.

## Webhooks

For anything Telegram is not — Slack via a workflow, a pager, your own router.

```ts
// The URL comes from NUXT_MONITOR_NOTIFICATIONS_WEBHOOK_URL at runtime.
channels: [{ type: 'webhook' }]
```

It receives a `POST` with the rendered text and the alerts themselves, so a
receiver that only forwards a string does not have to build one and a receiver
that routes on the issue does not have to parse it back out of a sentence.

```json
{
  "text": "New issue\n\nTypeError cart.total is not a function at cart.ts:12 (server)",
  "dashboardUrl": "https://app.example.com/_monitor",
  "alerts": [{ "reason": "new-issue", "at": 1737000000000, "issue": { … } }]
}
```

Every configured channel receives every alert. Routing particular issues to
particular channels arrives with watcher groups.

## The link in the message

`dashboardUrl` has to be set, and it has to be absolute. The module knows the
path it is mounted at but not the host it is served under — a request would tell
it, and alerts are raised from background flushes where there is no request.
Without it the message still describes the error; it just cannot offer the one
click that saves the navigation.

## When it does not arrive

The dashboard's Notifications section lists every attempt, including the ones
that were never sent. That is deliberate: the question people actually ask of an alerting
system is "why did nobody tell me?", and the answer is never among the
successes. A row is `sent`, `failed` with the reason the channel gave, or
`suppressed` with the rule that silenced it.

Delivery failures are also logged to the server console once each, because a
channel that quietly stopped working is otherwise invisible from inside the
application.

Nothing here can affect the application it watches. Channels are called detached
from the request, each attempt is bounded by a timeout, and a channel that
throws is recorded and stepped over — the events are written either way.

## Secrets

Channels are configured in `nuxt.config`, not in the dashboard. The credentials
should not be, and there is a specific reason why.

A channel is an entry in an array, and Nuxt can only override a `runtimeConfig`
value that is a plain key — `NUXT_MONITOR_*` cannot reach into a list. So a
token written into the config file, even as `process.env.X`, is resolved when
the app is **built** and ends up inside the build output: a secret in an image,
copied wherever that image goes. It is the same reason `databaseUrl` is read at
runtime.

These three are flat keys for exactly that reason, read when the server starts:

| Variable | Fills in |
| --- | --- |
| `NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_TOKEN` | The Telegram channel's `token` |
| `NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_CHAT_ID` | Its `chatId` |
| `NUXT_MONITOR_NOTIFICATIONS_WEBHOOK_URL` | The webhook channel's `url` |

They fill in only what a channel left blank, so a config that does spell out a
value keeps working. A channel still missing its credentials when the server
starts is skipped with a line in the log — half a configuration is a mistake
worth reporting once at boot, not a delivery failure to rediscover at 3am.

Whatever the source, credentials live under the private half of `runtimeConfig`
and never reach the browser; the dashboard's own API returns channel names and
types only.
