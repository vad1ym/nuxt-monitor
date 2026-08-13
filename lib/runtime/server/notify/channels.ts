import type { MonitorAlert, MonitorChannelOptions } from '../../../types'
import { formatMarkdown, formatText } from './format'

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
  if (channel.type === 'telegram') {
    return sendTelegram(channel.token, channel.chatId, alerts, context)
  }

  return sendWebhook(channel.url, channel.headers, alerts, context)
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
