import type { Database } from 'db0'
import type {
  MonitorAlert,
  MonitorChannelOptions,
  MonitorDelivery,
  MonitorNotificationOptions,
} from '../../../types'
import { channelName, send } from './channels'
import { isQuiet } from './quiet'

/**
 * Raising alerts without becoming the thing people mute.
 *
 * Three rules stand between an occurrence and a message, and each of them
 * exists because the version without it is worse than no alerting at all:
 *
 * - **Cooldown per issue.** One message about an issue, then silence about it
 *   for an hour. An error in a request handler under load happens thousands of
 *   times a minute, and each is the same fact.
 * - **Grouping.** New alerts wait a few seconds so that the four things one
 *   deploy broke arrive as one message about four things.
 * - **Quiet hours.** Suppressed rather than deferred, and logged either way.
 *
 * Everything here runs detached from the request that caused it. A chat API
 * being slow, unreachable or angry is not a reason for the application to be
 * any of those, so nothing in this file is ever awaited by a caller on the hot
 * path and nothing in it throws.
 */

/** Bound on one delivery attempt. */
const SEND_TIMEOUT_MS = 10_000

/**
 * Alerts held while waiting to be grouped.
 *
 * Bounded, because the queue is fed by the write path and drained on a timer:
 * an incident that produces new fingerprints faster than the group window
 * elapses would otherwise grow it without limit. Past this the newest are
 * dropped — the first alerts of an incident are the ones that describe it, and
 * a message listing five of two thousand says the same thing as one listing
 * five of fifty.
 */
const MAX_QUEUED = 50

/** Rows kept in the delivery log. Enough to cover a bad week. */
const MAX_LOG_ROWS = 500

export interface NotifierOptions extends MonitorNotificationOptions {
  /** Overridable so tests do not wait out a real group window. */
  now?: () => number
}

export class MonitorNotifier {
  private queue: MonitorAlert[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly channels: MonitorChannelOptions[]
  private readonly now: () => number
  /** The flush in flight, so a second one queues behind it rather than racing. */
  private sending: Promise<void> | undefined

  constructor(private options: NotifierOptions, private db: Database) {
    this.channels = (options.channels ?? []).filter(channel => channel.enabled !== false)
    this.now = options.now ?? Date.now
  }

  /** False when nothing is configured, so the store can skip the work entirely. */
  get active(): boolean {
    return this.options.enabled !== false && this.channels.length > 0
  }

  /** Milliseconds of silence per issue after it has been alerted on. */
  get cooldownMs(): number {
    return Math.max(0, this.options.cooldownMinutes ?? 60) * 60_000
  }

  /**
   * Accepts an alert, to be sent once the group window closes.
   *
   * Synchronous and cheap: this is called from inside the flush transaction's
   * aftermath, where the caller has events to finish writing.
   */
  enqueue(alert: MonitorAlert): void {
    if (this.closed || !this.active) {
      return
    }

    if (this.queue.length >= MAX_QUEUED) {
      return
    }

    this.queue.push(alert)

    const window = Math.max(0, this.options.groupWindowSeconds ?? 30) * 1_000

    if (window === 0) {
      void this.deliver()
      return
    }

    // Not reset by later alerts. A debounce that restarts on each arrival never
    // fires during an ongoing incident, which is the one time an alert is
    // actually wanted.
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.deliver()
    }, window)

    this.timer.unref?.()
  }

  /** Sends one alert immediately, bypassing grouping. For "send a test". */
  async sendNow(alert: MonitorAlert): Promise<MonitorDelivery[]> {
    return this.dispatch([alert])
  }

  /**
   * Sends what is queued.
   *
   * Serialised against itself for the same reason the store's flush is: two
   * overlapping drains would each take a slice of the queue and send two
   * messages where the grouping exists to send one.
   */
  private deliver(): Promise<void> {
    this.sending = this.sending
      ? this.sending.then(() => this.drain())
      : this.drain()

    return this.sending
  }

  private async drain(): Promise<void> {
    const batch = this.queue.splice(0)

    if (batch.length > 0) {
      await this.dispatch(batch)
    }
  }

  /**
   * Delivers one message per channel and records every attempt.
   *
   * Channels are independent: a Telegram token that has been revoked must not
   * stop a webhook that works, so each is awaited on its own and its outcome
   * logged separately.
   */
  private async dispatch(alerts: MonitorAlert[]): Promise<MonitorDelivery[]> {
    const at = this.now()

    if (isQuiet(this.options.quietHours, at)) {
      // Logged rather than dropped silently. "Did anything happen overnight" is
      // a real question, and a log that omits what it withheld cannot answer it.
      return this.record(alerts, 'quiet hours', 'suppressed')
    }

    const context = {
      dashboardUrl: this.options.dashboardUrl ?? '',
      timeoutMs: SEND_TIMEOUT_MS,
    }

    const deliveries = await Promise.all(this.channels.map(async (channel) => {
      try {
        await send(channel, alerts, context)

        return this.log(alerts, channelName(channel), 'sent')
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)

        // Reported once per failure rather than swallowed: a channel that stops
        // working is invisible from inside the application otherwise, and the
        // dashboard's log is only read by somebody who already suspects it.
        console.error(`[monitor] could not deliver an alert to ${channelName(channel)}: ${reason}`)

        return this.log(alerts, channelName(channel), 'failed', reason)
      }
    }))

    return deliveries
  }

  /** Writes one log row per channel, for outcomes that never reached a channel. */
  private async record(
    alerts: MonitorAlert[],
    detail: string,
    status: MonitorDelivery['status'],
  ): Promise<MonitorDelivery[]> {
    return Promise.all(this.channels.map(
      channel => this.log(alerts, channelName(channel), status, detail),
    ))
  }

  /**
   * Records one attempt.
   *
   * Never throws. A delivery log that can fail a flush turns a full disk into a
   * failure of the write path it is only supposed to describe.
   */
  private async log(
    alerts: MonitorAlert[],
    channel: string,
    status: MonitorDelivery['status'],
    detail?: string,
  ): Promise<MonitorDelivery> {
    const entry: MonitorDelivery = {
      id: 0,
      at: this.now(),
      channel,
      reason: alerts[0]?.reason ?? 'test',
      fingerprint: alerts.length === 1 ? alerts[0]?.issue.fingerprint : undefined,
      alerts: alerts.length,
      status,
      detail,
    }

    try {
      await this.db.prepare(`
        INSERT INTO notifications (at, channel, reason, fingerprint, alerts, status, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.at,
        entry.channel,
        entry.reason,
        entry.fingerprint ?? null,
        entry.alerts,
        entry.status,
        detail?.slice(0, 500) ?? null,
      )
    }
    catch (error) {
      console.error('[monitor] could not write to the notification log', error)
    }

    return entry
  }

  /** Drops log rows past the ceiling. Called from the retention sweep. */
  async trimLog(): Promise<void> {
    await this.db.prepare(`
      DELETE FROM notifications
      WHERE at < (
        SELECT MIN(at) FROM (
          SELECT at FROM notifications ORDER BY at DESC LIMIT ?
        ) AS _kept
      )
    `).run(MAX_LOG_ROWS)
  }

  /**
   * Sends anything still queued, then stops.
   *
   * Draining rather than discarding: a process shutting down right after an
   * error is the case where the alert matters most, and it is also exactly when
   * a group window is most likely to still be open.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    await this.deliver()
    this.closed = true
  }
}
