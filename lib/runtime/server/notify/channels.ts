import type { MonitorAlert, MonitorChannelOptions, MonitorSlackChannel } from '../../../types'
import { formatMarkdown, formatSlack, formatText } from './format'

/**
 * Delivery.
 *
 * One function per destination, behind a shape narrow enough that adding Slack
 * or email later is a file rather than a branch through the rest of the module:
 * take the alerts and the dashboard URL, put them somewhere, throw if that did
 * not happen. Everything about *whether* to send lives above this.
 */

export interface ChannelContext {
  /** Absolute dashboard URL, when configured. Empty otherwise. */
  dashboardUrl: string
  /** Bounds each attempt. A channel must not hold a flush open. */
  timeoutMs: number
}

/** Display name for the delivery log. */
export function channelName(channel: MonitorChannelOptions): string {
  return channel.name || channel.type
}

/**
 * Sends, or throws with a reason worth reading in the log.
 *
 * Never swallows: the caller records every attempt and its outcome, and a
 * channel that reported success on a 401 would make that log a lie.
 */
export async function send(
  channel: MonitorChannelOptions,
  alerts: MonitorAlert[],
  context: ChannelContext,
): Promise<void> {
  // Non-null because `resolveChannels` dropped every channel that was still
  // missing its credentials — a channel reaching here is one that can be used.
  if (channel.type === 'telegram') {
    return sendTelegram(channel.token!, channel.chatId!, alerts, context)
  }

  if (channel.type === 'slack') {
    return sendSlack(channel, alerts, context)
  }

  return sendWebhook(channel.url!, channel.headers, alerts, context)
}

/**
 * `fetch` with a deadline.
 *
 * Without one, a chat API that accepts the connection and never answers holds a
 * flush open indefinitely — and flushes are serialised, so that is the whole
 * write path stopped by an unrelated third party.
 */
async function post(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...init, method: 'POST', signal: controller.signal })
  }
  finally {
    clearTimeout(timer)
  }
}

async function sendTelegram(
  token: string,
  chatId: string,
  alerts: MonitorAlert[],
  context: ChannelContext,
): Promise<void> {
  const response = await post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatMarkdown(alerts, context.dashboardUrl),
        parse_mode: 'MarkdownV2',
        // The link in the message is the point of it; a preview card of the
        // dashboard's login page is not.
        link_preview_options: { is_disabled: true },
      }),
    },
    context.timeoutMs,
  )

  if (!response.ok) {
    // Telegram puts the actual reason in the body — "chat not found", "bot was
    // blocked by the user" — and the status alone is 400 for all of them.
    // Without the body the log says a channel failed and nothing about why.
    throw new Error(`Telegram answered ${response.status}: ${(await safeText(response)).slice(0, 200)}`)
  }
}

/**
 * Slack, by whichever route the channel was given.
 *
 * The webhook wins when both are set. It has to: a hook URL already names its
 * destination channel, so honouring the token as well would post the same alert
 * twice, and `resolveChannels` cannot decide it either — a config with both is
 * a config that meant one of them.
 */
async function sendSlack(
  channel: MonitorSlackChannel,
  alerts: MonitorAlert[],
  context: ChannelContext,
): Promise<void> {
  const message = formatSlack(alerts, context.dashboardUrl)

  if (channel.webhookUrl) {
    const response = await post(
      channel.webhookUrl,
      { headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) },
      context.timeoutMs,
    )

    if (!response.ok) {
      // An incoming hook answers in plain text — `no_service`, `channel_not_found`,
      // `invalid_payload` — and those words are the whole diagnosis.
      throw new Error(`Slack answered ${response.status}: ${(await safeText(response)).slice(0, 200)}`)
    }

    return
  }

  const response = await post(
    'https://slack.com/api/chat.postMessage',
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'authorization': `Bearer ${channel.token!}`,
      },
      body: JSON.stringify({
        channel: channel.channel!,
        ...message,
        // The message links to the dashboard; an unfurled card of its login
        // page underneath every alert is noise.
        unfurl_links: false,
        unfurl_media: false,
      }),
    },
    context.timeoutMs,
  )

  if (!response.ok) {
    throw new Error(`Slack answered ${response.status}`)
  }

  // The Web API answers 200 with `ok: false` for everything that actually goes
  // wrong — `invalid_auth`, `not_in_channel`, `channel_not_found`. Checking the
  // status alone would log a successful delivery for a message nobody received,
  // which is the one failure this whole feature cannot afford to hide.
  const body = await response.json().catch(() => null) as { ok?: boolean, error?: string } | null

  if (!body?.ok) {
    throw new Error(`Slack rejected the message: ${body?.error ?? 'unknown error'}`)
  }
}

async function sendWebhook(
  url: string,
  headers: Record<string, string> | undefined,
  alerts: MonitorAlert[],
  context: ChannelContext,
): Promise<void> {
  const response = await post(
    url,
    {
      headers: { 'content-type': 'application/json', ...headers },
      // The alerts as they are, plus the rendered text. A receiver that only
      // forwards a string should not have to build one, and one that routes on
      // the issue should not have to parse it back out of a sentence.
      body: JSON.stringify({
        text: formatText(alerts, context.dashboardUrl),
        dashboardUrl: context.dashboardUrl || undefined,
        alerts,
      }),
    },
    context.timeoutMs,
  )

  if (!response.ok) {
    throw new Error(`Webhook answered ${response.status}`)
  }
}

/** Reading a body can itself fail; the status is still worth reporting. */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  }
  catch {
    return ''
  }
}
