import type { MonitorAlert, MonitorAlertReason } from '../../../types'

/**
 * What an alert says.
 *
 * The message is the whole product of this feature — everything else decides
 * whether to send one. It has about two seconds of attention on a phone, so it
 * leads with what happened and where, and puts the link within reach.
 */

const HEADLINE: Record<MonitorAlertReason, string> = {
  'new-issue': 'New issue',
  // Named for what it means to the reader, not for the state transition: the
  // interesting part is that something believed fixed is not.
  'regression': 'Regression',
  'threshold': 'Issue growing',
  'test': 'Test alert',
}

/** How many issues a grouped message names before it summarises the rest. */
const MAX_LISTED = 5

/** Message length is bounded by Telegram at 4096; stay well inside it. */
const MAX_MESSAGE = 380

/** Plain text, for webhooks and for tests to read without unescaping. */
export function formatText(alerts: MonitorAlert[], dashboardUrl: string): string {
  return render(alerts, dashboardUrl, value => value)
}

/**
 * Telegram MarkdownV2.
 *
 * Escaping is not optional there: an unescaped `.` or `-` anywhere in the text
 * makes the API reject the whole message with a 400, and error messages are
 * exactly the place where brackets and dots turn up. So the escape is applied
 * to every interpolated value and the markup is added around it.
 */
export function formatMarkdown(alerts: MonitorAlert[], dashboardUrl: string): string {
  return render(alerts, dashboardUrl, escapeMarkdown, {
    bold: value => `*${value}*`,
    code: value => `\`${value}\``,
    // The URL is escaped by a different rule than the label, and it has to be:
    // inside `(...)` MarkdownV2 reserves only `)` and `\`, so applying the full
    // set here would put backslashes into the link that the parser then eats,
    // and the link would point somewhere else. The one that actually bites is
    // an unescaped `)` — it ends the link early, and what follows is loose text
    // that usually takes the rest of the message down with it.
    link: (label, url) => `[${label}](${escapeUrl(url)})`,
  })
}

interface Markup {
  bold: (value: string) => string
  code: (value: string) => string
  link: (label: string, url: string) => string
}

const PLAIN: Markup = {
  bold: value => value,
  code: value => value,
  link: (label, url) => `${label}: ${url}`,
}

function render(
  alerts: MonitorAlert[],
  dashboardUrl: string,
  escape: (value: string) => string,
  markup: Markup = PLAIN,
): string {
  if (alerts.length === 0) {
    return ''
  }

  const lines: string[] = [markup.bold(escape(summary(alerts)))]

  for (const alert of alerts.slice(0, MAX_LISTED)) {
    lines.push('', describe(alert, escape, markup))
  }

  if (alerts.length > MAX_LISTED) {
    lines.push('', escape(`…and ${alerts.length - MAX_LISTED} more.`))
  }

  const link = issueLink(alerts, dashboardUrl)

  if (link) {
    // The label follows the target rather than the count, or a test alert
    // would say "Open issue" about a link to the dashboard.
    const toIssue = link.includes('/issues/')

    lines.push('', markup.link(escape(toIssue ? 'Open issue' : 'Open dashboard'), link))
  }

  return lines.join('\n')
}

/** The first line: what happened, in the plural when it happened several times. */
function summary(alerts: MonitorAlert[]): string {
  if (alerts.length === 1) {
    return HEADLINE[alerts[0]!.reason]
  }

  // Grouped alerts are frequently all of a kind — a deploy produces new issues,
  // nothing else — and "4 new issues" reads better than "4 alerts".
  const reasons = new Set(alerts.map(alert => alert.reason))

  if (reasons.size === 1) {
    const [reason] = [...reasons]

    return `${alerts.length} × ${HEADLINE[reason!]}`
  }

  return `${alerts.length} alerts`
}

function describe(alert: MonitorAlert, escape: (value: string) => string, markup: Markup): string {
  const { issue } = alert
  const where = issue.culprit || issue.route

  // For a manual report the type is always `MonitorException`, which says
  // nothing — the group and the level are what the caller chose to tell us, so
  // they take the slot. `payments/critical` is the first thing worth reading.
  const label = issue.manual
    ? [issue.group, issue.level].filter(Boolean).join('/') || 'exception'
    : issue.type

  const parts = [
    markup.code(escape(label)),
    escape(truncate(issue.message, MAX_MESSAGE)),
  ]

  if (where) {
    parts.push(escape(`at ${where}`))
  }

  if (alert.reason === 'threshold') {
    parts.push(escape(`— ${issue.count} occurrences`))
  }

  // The side answers "is this mine to fix right now" faster than anything else
  // in the line: a client error is a browser somewhere, a server error is this
  // process.
  parts.push(escape(`(${issue.side})`))

  return parts.join(' ')
}

/**
 * Where the message points.
 *
 * Straight at the issue when there is one, because the alert exists to save the
 * navigation. With several, the list is the only page that shows all of them.
 */
function issueLink(alerts: MonitorAlert[], dashboardUrl: string): string {
  if (!dashboardUrl) {
    return ''
  }

  const base = dashboardUrl.replace(/\/+$/, '')

  // A test alert describes no stored issue, so linking at one lands on a 404 —
  // from the very message somebody sent to confirm the setup works, which is
  // the worst possible moment to show them a broken link.
  return alerts.length === 1 && alerts[0]!.reason !== 'test'
    ? `${base}/issues/${alerts[0]!.issue.fingerprint}`
    : base
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()

  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** Every character MarkdownV2 reserves in ordinary text. Missing one costs the whole message. */
function escapeMarkdown(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, character => `\\${character}`)
}

/** The two MarkdownV2 reserves inside a link target — and only those two. */
function escapeUrl(value: string): string {
  return value.replace(/[)\\]/g, character => `\\${character}`)
}
