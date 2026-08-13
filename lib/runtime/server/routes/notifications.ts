import { defineEventHandler, getQuery, readBody } from '#imports'
import { monitorConfig, requireDashboardAccess, useMonitorStore } from '../context'
import { channelName } from '../notify/channels'
import { resolveChannels } from '../notify/notifier'

/**
 * The alerting section's data, and its one action.
 *
 * `GET` answers what is configured and what has been sent; `POST` sends a test
 * alert. The test is the whole reason this route takes a write at all: a
 * channel is a token and a chat id copied from a phone, and the only way to
 * know they are right is to make the message appear. Discovering a typo when
 * the first real incident stays silent is discovering it at the worst moment.
 */
export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const store = await useMonitorStore()

  if (event.method === 'POST') {
    const notifier = store.alerts

    if (!notifier) {
      // 400 rather than 404: the route exists and the caller is authenticated;
      // what is missing is a configured channel, and saying so is the answer.
      return { sent: false, reason: 'No notification channel is configured.' }
    }

    // The body is ignored beyond this: what a test sends is not the caller's
    // choice, or the endpoint becomes a way to post arbitrary text through
    // somebody's bot token.
    await readBody(event).catch(() => undefined)

    const deliveries = await notifier.sendNow({
      reason: 'test',
      at: Date.now(),
      issue: {
        fingerprint: 'test',
        type: 'MonitorTest',
        message: 'Test alert from nuxt-monitor. Delivery is working.',
        side: 'server',
        count: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        resolved: false,
        ignored: false,
      },
    })

    return { sent: deliveries.every(delivery => delivery.status === 'sent'), deliveries }
  }

  const config = monitorConfig().notifications ?? {}
  const limit = Math.min(200, Math.max(1, Number(getQuery(event).limit) || 100))

  // Which of the configured channels the server could actually resolve
  // credentials for. Compared by name below so a channel declared but skipped
  // reads as broken rather than as absent — those are different problems and
  // "nothing is configured" is the wrong advice for the second one.
  const usable = new Set(resolveChannels(config).map(channelName))

  return {
    enabled: Boolean(store.alerts),
    // Names and types only. A token in a dashboard response is a token in a
    // browser's memory, its devtools and anything that later reads either.
    channels: (config.channels ?? []).map(channel => ({
      name: channelName(channel),
      type: channel.type,
      enabled: channel.enabled !== false,
      /** False when the channel has no token or URL from any source. */
      usable: usable.has(channelName(channel)),
    })),
    triggers: config.triggers ?? {},
    cooldownMinutes: config.cooldownMinutes ?? 60,
    groupWindowSeconds: config.groupWindowSeconds ?? 30,
    quietHours: config.quietHours,
    deliveries: await store.deliveries(limit),
  }
})
