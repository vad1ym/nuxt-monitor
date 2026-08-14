import type { MonitorAlert, MonitorChannelOptions, MonitorLevel } from '../../../types'

/**
 * Which alerts belong on which channel.
 *
 * Without this every channel receives everything, which is the right default
 * and the wrong ceiling: the reason to name a priority group at the call site
 * is so that the people who can act on it are the ones who hear about it. A
 * payments alert in a general channel is one line among fifty, and the whole
 * cost of alerting is paid in attention.
 *
 * Kept apart from delivery because it is a pure predicate over a channel and an
 * alert — the part of alerting most likely to be argued about, and the part
 * that should be answerable without a database or a bot token.
 */

const ORDER: Record<MonitorLevel, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
}

/**
 * A caught error's severity.
 *
 * `error`, because that is what having been thrown amounts to. Treating it as
 * unset instead would make `minLevel: 'warning'` silently drop every genuine
 * exception, which is the opposite of what somebody raising a floor means.
 */
const CAUGHT_LEVEL: MonitorLevel = 'error'

export function accepts(channel: MonitorChannelOptions, alert: MonitorAlert): boolean {
  // A test alert is a check that this channel works, so it goes to the channel
  // being tested whatever its filters say. Applying them would make a silent
  // test indistinguishable from a broken one.
  if (alert.reason === 'test') {
    return true
  }

  if (channel.groups?.length) {
    const group = alert.issue?.group

    // A caught error has no group, so a channel that names groups does not
    // receive it. Naming one is a statement about what this channel is for —
    // and an application-wide alert belongs to no group by construction, so it
    // is not what a channel about payments asked to hear.
    if (!group || !channel.groups.includes(group)) {
      return false
    }
  }

  if (channel.minLevel) {
    // An alert with no issue carries no level of its own. Treated as
    // `critical` rather than as unset: the failure rate of the whole
    // application crossing its threshold is the most severe thing this module
    // can say, and defaulting it to `error` would let `minLevel: 'critical'`
    // silence exactly the alert that floor was raised to keep.
    const level = alert.issue ? alert.issue.level ?? CAUGHT_LEVEL : 'critical'

    return ORDER[level] >= ORDER[channel.minLevel]
  }

  return true
}

/** The alerts this channel should be sent, in order. Empty means send nothing. */
export function alertsFor(channel: MonitorChannelOptions, alerts: MonitorAlert[]): MonitorAlert[] {
  return alerts.filter(alert => accepts(channel, alert))
}
