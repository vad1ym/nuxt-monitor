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

## Slack in two minutes

An incoming webhook is the short way, and the one to use unless you need the
other. It needs no bot token and no scopes, and the channel is chosen when you
create the hook.

1. Open [your Slack apps](https://api.slack.com/apps), create an app in the
   workspace, and turn on **Incoming Webhooks**.
2. **Add New Webhook to Workspace**, pick the channel, and copy the URL.
3. Put it in the environment and restart.

```ts
notifications: {
  channels: [{ type: 'slack' }],
  dashboardUrl: 'https://app.example.com/_monitor',
}
```

```bash
NUXT_MONITOR_NOTIFICATIONS_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T…/B…/…
```

The URL is a credential: anyone holding it can post to that channel. Treat it
like the bot token it replaces, and keep it out of the config file — a value
written there is resolved at build time and ends up inside the build artefact.

### A bot token instead

Worth the extra setup for one thing: several channels from one credential —
payments alerts to `#payments` and the rest to `#alerts`, without creating a
second hook for each.

Give the app the `chat:write` scope, install it, and **invite the bot to every
channel it posts to** — Slack answers `not_in_channel` otherwise, which the
delivery log shows verbatim.

```ts
channels: [
  { type: 'slack', name: 'payments', channel: '#payments', groups: ['payments'] },
  { type: 'slack', name: 'engineering', channel: '#alerts' },
]
```

```bash
NUXT_MONITOR_NOTIFICATIONS_SLACK_TOKEN=xoxb-…
```

A channel carrying both a webhook URL and a token uses the webhook: a hook
already names its destination, so honouring both would post the alert twice.

Then open the dashboard's Notifications section and send a test.

## What raises an alert

Six triggers. The first three are on by default; the last three are off until
you set them. Types and defaults are in the
[config reference](../config/#notificationstriggers).

| Trigger | Fires when |
| --- | --- |
| `newIssue` | A fingerprint is seen for the first time |
| `regression` | An issue marked resolved happens again |
| `thresholds` | An issue's count crosses `10`, `100` or `1000` |
| `spike` | An issue starts happening far faster than it used to |
| `errorRate` | The application's failure rate crosses a fraction you set |
| `silence` | Nothing at all has been recorded for a while |

```ts
triggers: {
  newIssue: false,
  thresholds: [50, 500],   // `[]` turns thresholds off
  spike: { factor: 5, minimum: 10 },
  errorRate: { above: 0.25, minimumRequests: 20 },
  silence: { after: 2 * 60 * 60 * 1000 },
}
```

`regression` is the one worth keeping if you keep only one: somebody said this
was fixed, and it was not. Nothing else in the tool contradicts a human on the
record.

`errorRate` names no issue in its message, because pointing at one would blame
a symptom that may not be the cause.

`silence` says "nothing recorded", never "the application is down" — those are
different claims and it cannot tell them apart: your app may be serving fine
while the monitor behind it is the thing that stopped. It stays quiet until the
database knows what normal was, and on an application quiet enough that silence
*is* normal.

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

For anything the built-in channels are not — a pager, an incident tool, your
own router. Slack has [a channel of its own](#slack-in-two-minutes); it does not
need one of these.

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

## Sending different things to different places

By default every configured channel receives every alert. A channel can narrow
that to the priority groups it cares about, and to a severity floor:

```ts
channels: [
  { type: 'telegram', name: 'payments', groups: ['payments'], minLevel: 'error' },
  { type: 'telegram', name: 'engineering' },
]
```

Groups come from [`exception()`](./reporting#groups). A channel that names them
receives only those groups, and therefore no caught errors — those carry no
group. Leave `groups` unset for a channel that should see everything.

`minLevel` compares against the level a manual report was raised with, treating
a caught error as `error` so that raising the floor to `warning` does not
silently drop genuine exceptions.

A channel whose filters exclude everything is not written to the delivery log:
it did what it was configured to do, unlike quiet hours, which withholds
something the reader would otherwise have received.

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

These are flat keys for exactly that reason, read when the server starts:

| Variable | Fills in |
| --- | --- |
| `NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_TOKEN` | The Telegram channel's `token` |
| `NUXT_MONITOR_NOTIFICATIONS_TELEGRAM_CHAT_ID` | Its `chatId` |
| `NUXT_MONITOR_NOTIFICATIONS_SLACK_WEBHOOK_URL` | The Slack channel's `webhookUrl` |
| `NUXT_MONITOR_NOTIFICATIONS_SLACK_TOKEN` | Its `token`, when posting via the API |
| `NUXT_MONITOR_NOTIFICATIONS_WEBHOOK_URL` | The webhook channel's `url` |

They fill in only what a channel left blank, so a config that does spell out a
value keeps working. A channel still missing its credentials when the server
starts is skipped with a line in the log — half a configuration is a mistake
worth reporting once at boot, not a delivery failure to rediscover at 3am.

Whatever the source, credentials live under the private half of `runtimeConfig`
and never reach the browser; the dashboard's own API returns channel names and
types only.
