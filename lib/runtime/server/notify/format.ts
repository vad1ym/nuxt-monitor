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
  // A group somebody asked to hear about, failing again.
  'watched': 'Watched group',
  // Not "growing": a threshold says an issue got bigger, this says it got
  // faster, and the two come apart on exactly the issue worth waking up for —
  // one that passed every count months ago and just went vertical.
  'spike': 'Sudden spike',
  // The only one that is not about an issue at all.
  'error-rate': 'Failure rate high',
  // Not "application down": all that is known is that nothing arrived, and the
  // collector is as likely to be the thing that stopped as the application.
  'silence': 'Nothing reported',
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

/** Loose on purpose: Block Kit has many block types and we emit four. */
export type SlackBlock = Record<string, unknown>

/**
 * The header's emoji, by reason.
 *
 * A channel is read by scanning, and colour is the fastest thing to scan. The
 * distinction that matters is regression against the rest: everything else is
 * news, that one is a claim somebody made turning out to be false.
 */
const ICON: Record<MonitorAlertReason, string> = {
  'new-issue': '🔴',
  'regression': '🔁',
  'threshold': '📈',
  'watched': '👀',
  'spike': '🚨',
  'error-rate': '🔥',
  'silence': '🔇',
  'test': '✅',
}

/**
 * Slack Block Kit.
 *
 * Structure rather than a string, which is why this is its own function and not
 * another `Markup`: the others differ in how they decorate one rendered line,
 * and Slack's difference is that there are no lines — there are blocks, and the
 * link is a button rather than text.
 *
 * Worth the extra shape because of where these are read. A Slack alert lands in
 * a channel among other people's messages, and a paragraph of plain text scrolls
 * past as one more of them; a header and a button read as an alert at a glance.
 *
 * The `text` alongside is not a fallback nobody sees — it is what Slack puts in
 * the phone notification and the sidebar preview, which for most readers is the
 * only part they read before deciding whether to open it.
 */
export function formatSlack(alerts: MonitorAlert[], dashboardUrl: string): {
  text: string
  blocks: SlackBlock[]
} {
  const text = formatText(alerts, dashboardUrl)

  if (alerts.length === 0) {
    return { text, blocks: [] }
  }

  const blocks: SlackBlock[] = [{
    type: 'header',
    // `plain_text` is literal — no escaping, and no markup either, so the
    // emoji has to carry the severity on its own.
    text: { type: 'plain_text', text: `${ICON[alerts[0]!.reason]} ${summary(alerts)}`, emoji: true },
  }]

  for (const alert of alerts.slice(0, MAX_LISTED)) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: slackLine(alert) },
    })

    const context = slackContext(alert)

    if (context) {
      // A context block is smaller and greyer than a section, which is exactly
      // the weight this deserves: it qualifies the error rather than stating it.
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context }] })
    }
  }

  if (alerts.length > MAX_LISTED) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `…and ${alerts.length - MAX_LISTED} more.` }],
    })
  }

  const link = issueLink(alerts, dashboardUrl)

  if (link) {
    const toIssue = link.includes('/issues/')

    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: toIssue ? 'Open issue' : 'Open dashboard' },
        url: link,
      }],
    })
  }

  return { text, blocks }
}

/** The error itself: what broke, and where. */
function slackLine(alert: MonitorAlert): string {
  const { issue } = alert

  // An application-wide alert has no issue to describe, and picking one to
  // stand in for it would name a symptom that may not be the cause.
  if (!issue) {
    return escapeSlack(rateLine(alert))
  }

  const where = issue.culprit || issue.route

  const label = issue.manual
    ? [issue.group, issue.level].filter(Boolean).join('/') || 'exception'
    : issue.type

  const parts = [
    `*${escapeSlack(label)}*`,
    escapeSlack(truncate(issue.message, MAX_MESSAGE)),
  ]

  if (where) {
    // Escaped inside the backticks, not around them: the markup is ours and
    // must survive, the value is not and must not.
    parts.push(`\`${escapeSlack(where)}\``)
  }

  return parts.join(' ')
}

/**
 * The qualifiers, on their own quieter line.
 *
 * Deliberately not the release: an issue does not carry one, and a context line
 * that invents a version is worse than one that omits it.
 */
function slackContext(alert: MonitorAlert): string {
  const { issue } = alert

  if (!issue) {
    return ''
  }

  const parts: string[] = [issue.side]

  if (issue.group) {
    parts.push(issue.group)
  }

  if (issue.method && issue.route) {
    parts.push(`${issue.method} ${issue.route}`)
  }

  if (alert.reason === 'threshold') {
    parts.push(`${issue.count} occurrences`)
  }

  // How much faster, which is the entire content of a spike: without it the
  // message says an issue is happening, which the reader already assumed.
  if (alert.reason === 'spike' && alert.factor) {
    parts.push(`${alert.factor}× its usual rate`, `${issue.count} occurrences`)
  }

  return parts.map(escapeSlack).join(' · ')
}

/**
 * The failure rate as a sentence.
 *
 * Both numbers, never the percentage alone: "80% of requests failed" is an
 * emergency at 500 requests and a rounding error at five, and the reader
 * cannot tell which without the denominator.
 */
function rateLine(alert: MonitorAlert): string {
  if (alert.reason === 'silence') {
    return silenceLine(alert)
  }

  const rate = alert.rate

  if (!rate?.total) {
    return 'The application failure rate crossed its threshold.'
  }

  const percent = Math.round((rate.failed / rate.total) * 100)

  return `${percent}% of requests failed — ${rate.failed} of ${rate.total}.`
}

/**
 * The alert about an absence, which has to say what it does *not* know.
 *
 * Worded as "nothing has been recorded" rather than "the application is down",
 * because those are different claims and this one cannot tell them apart: the
 * application may be serving perfectly while the collector behind it is the
 * thing that died. Naming the wrong one sends somebody to the wrong system
 * during the minutes that matter.
 */
function silenceLine(alert: MonitorAlert): string {
  const quiet = alert.quietFor

  if (!quiet) {
    return 'Nothing has been recorded for a while — check that the monitor is still collecting.'
  }

  return `Nothing recorded for ${describeSpan(quiet.sinceMs)}. Either traffic stopped or the monitor did.`
}

/** A duration as somebody would say it out loud. */
function describeSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)

  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }

  const days = Math.round(hours / 24)

  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * Slack's three, and only those three.
 *
 * `mrkdwn` is not Markdown: it reserves almost nothing, and over-escaping is
 * the real hazard — a backslash before a dot is rendered as a backslash and a
 * dot, so applying Telegram's rule here would litter every message. What Slack
 * does consume is the HTML-ish trio, and an unescaped `<` in `Cannot read
 * <anonymous>` swallows everything to the next `>`.
 */
function escapeSlack(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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

  // The application-wide alert. No issue to name, and naming one anyway would
  // point at a symptom rather than the cause.
  if (!issue) {
    return escape(rateLine(alert))
  }

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

  // The number that *is* the alert. A spike without its factor reads as a
  // notification that an error happened, which the reader assumed already.
  if (alert.reason === 'spike' && alert.factor) {
    parts.push(escape(`— ${alert.factor}× its usual rate, ${issue.count} occurrences`))
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
  // the worst possible moment to show them a broken link. An `error-rate`
  // alert has no issue for a different reason but lands the same way, so the
  // check is on the issue itself rather than on the reason.
  const only = alerts.length === 1 ? alerts[0]! : undefined

  return only && only.reason !== 'test' && only.issue
    ? `${base}/issues/${only.issue.fingerprint}`
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
