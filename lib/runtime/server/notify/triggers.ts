import type { MonitorAlert, MonitorIssue, MonitorTriggerOptions } from '../../../types'

/**
 * What is worth an alert.
 *
 * Pure, and separate from sending, because "should this have been an alert?" is
 * the question that gets argued about — and it is answerable here from a row
 * and a set of options, with no clock, no network and no database.
 */

/** An order of magnitude at a time. Ten of something is a pattern; two is not. */
const DEFAULT_THRESHOLDS = [10, 100, 1_000]

/** How much faster than usual counts as a spike, when `spike: true`. */
const DEFAULT_SPIKE_FACTOR = 5

/**
 * Occurrences in this flush below which a spike is not claimed.
 *
 * Ratios are wild at small numbers: an issue that happened once an hour and
 * now happens three times in a minute is ×180 by arithmetic and nothing at all
 * by judgement. This is the floor that keeps the trigger describing outages
 * rather than noise.
 */
const DEFAULT_SPIKE_MINIMUM = 10

/** Requests below which an error rate is not worth reporting. */
const DEFAULT_MINIMUM_REQUESTS = 20

/**
 * How long nothing may arrive before it is worth saying so, when `silence: true`.
 *
 * Two hours is chosen to sit well clear of a deploy. A restart stops
 * collection for seconds and a slow rollout for minutes; a threshold near
 * either would raise an alert on every release, and an alert that fires on
 * routine work is one people learn to close without reading.
 */
const DEFAULT_SILENCE_MS = 2 * 60 * 60 * 1_000

/**
 * History needed before silence means anything, as a multiple of the threshold.
 *
 * A two-hour rule cannot be applied by a database that has been collecting for
 * two hours: it has never seen this application awake for long enough to know
 * that quiet is unusual. Scaling with the threshold rather than fixing a span
 * keeps a short rule usable on a busy service without arming instantly.
 */
const MIN_HISTORY_FACTOR = 3

/**
 * Requests over the observed history below which quiet is simply normal.
 *
 * An internal tool nobody opens at night is silent every night, and a trigger
 * that fires on that is an alarm clock rather than a monitor.
 */
const MIN_SILENCE_REQUESTS = 100

export interface IssueState {
  /** Count before this flush wrote to the issue. `0` for a fingerprint never seen. */
  previousCount: number
  /** Whether the issue was marked resolved before this flush reopened it. */
  wasResolved: boolean
  /** Highest threshold already announced. */
  alertedCount: number
  /** When this issue last raised an alert. `0` for never. */
  alertedAt: number
  /**
   * The issue's established rate, in occurrences per minute, before this flush.
   *
   * Absent when there is no history to compare against — a brand-new issue, or
   * one whose whole life fits inside one flush. `newIssue` already covers the
   * first, and the second has no "usual" to be faster than.
   */
  ratePerMinute?: number
  /** Occurrences written in this flush, for judging the rate now. */
  addedCount?: number
  /** Milliseconds this flush covered, for turning `addedCount` into a rate. */
  spanMs?: number
}

/**
 * Decides what this issue's new occurrences deserve, if anything.
 *
 * At most one alert per issue per flush, in the order they matter: a
 * regression that also crosses a threshold is a regression, and saying both
 * would be two messages about one event. `undefined` is the common answer —
 * the overwhelming majority of occurrences are of issues somebody has already
 * been told about.
 */
export function evaluate(
  issue: MonitorIssue,
  state: IssueState,
  options: MonitorTriggerOptions | undefined,
  at: number,
  /** True when the issue's group is configured with `notify: true`. */
  watched = false,
): MonitorAlert | undefined {
  // Explicitly put aside as not worth acting on. Alerting on it anyway would
  // make the ignore button a lie in the one place it is most needed: an issue
  // is ignored *because* it is noisy, and noisy is what raises alerts.
  if (issue.ignored) {
    return undefined
  }

  if (state.previousCount === 0 && options?.newIssue !== false) {
    return { reason: 'new-issue', issue, at }
  }

  // Only for an issue that existed and was resolved: a brand-new fingerprint is
  // new, not a regression, however the row was written.
  if (state.wasResolved && state.previousCount > 0 && options?.regression !== false) {
    return { reason: 'regression', issue, at }
  }

  // Before the threshold, deliberately. The two can fire together — an issue
  // going vertical also passes counts on the way — and of the two "it is
  // happening five times faster than usual" is the one that says something
  // changed just now. A threshold says only that a total got bigger, which for
  // a busy issue is true every day.
  const factor = spikeFactor(state, options)

  if (factor !== undefined) {
    return { reason: 'spike', issue, factor, at }
  }

  const crossed = crossedThreshold(issue.count, state, options)

  if (crossed !== undefined) {
    return { reason: 'threshold', issue, threshold: crossed, at }
  }

  // A watched group is the last word: `notify: true` says this part of the
  // application is worth hearing about whenever it fails, not only the first
  // time or on the way past ten. Checked after the others so a regression in a
  // watched group is still reported as a regression — the more specific fact
  // wins, and this is the fallback for everything else.
  //
  // Still subject to the per-issue cooldown applied by the store, which is
  // what keeps "every failure" from meaning "every occurrence".
  return watched ? { reason: 'watched', issue, at } : undefined
}

/**
 * How many times its usual rate this issue is running at, if that is a spike.
 *
 * Compares occurrences per minute in this flush against the rate the issue had
 * established before it. `undefined` — no alert — whenever the comparison
 * cannot be made honestly: no history, no elapsed time, or too few occurrences
 * for a ratio to mean anything.
 */
function spikeFactor(
  state: IssueState,
  options: MonitorTriggerOptions | undefined,
): number | undefined {
  const spike = options?.spike

  if (!spike) {
    return undefined
  }

  const settings = typeof spike === 'object' ? spike : {}
  const threshold = settings.factor ?? DEFAULT_SPIKE_FACTOR
  const minimum = settings.minimum ?? DEFAULT_SPIKE_MINIMUM

  const added = state.addedCount ?? 0
  const spanMs = state.spanMs ?? 0
  const before = state.ratePerMinute

  // Every one of these is "cannot tell", not "no spike". An issue with no
  // previous rate is new; a flush covering no time has no rate to speak of;
  // and a handful of occurrences is not a trend however it divides.
  if (!before || spanMs <= 0 || added < minimum) {
    return undefined
  }

  const now = added / (spanMs / 60_000)
  const factor = now / before

  // Rounded for the message, and compared after rounding so the number the
  // reader sees is the number that fired: "5× its usual rate" from a factor of
  // 4.6 invites the reply "that's not five".
  const rounded = Math.round(factor)

  return rounded >= threshold ? rounded : undefined
}

/**
 * Whether the application's failure rate is worth an alert.
 *
 * Separate from `evaluate` because it is not about an issue: it takes counted
 * requests, not a row, and it can fire in a flush where every individual issue
 * is unremarkable. Fifty small faults that each stay under every threshold are
 * still a checkout nobody can complete.
 */
export function evaluateErrorRate(
  counts: { failed: number, total: number },
  options: MonitorTriggerOptions | undefined,
  at: number,
): MonitorAlert | undefined {
  const setting = options?.errorRate

  if (setting === undefined) {
    return undefined
  }

  const above = typeof setting === 'object' ? setting.above : setting
  const minimum = typeof setting === 'object'
    ? setting.minimumRequests ?? DEFAULT_MINIMUM_REQUESTS
    : DEFAULT_MINIMUM_REQUESTS

  // A rate needs a denominator worth dividing by. Three failures out of four
  // requests at 4am is 75% and is not an outage; without this the trigger is
  // loudest exactly when the application is quietest.
  if (counts.total < minimum || counts.total === 0) {
    return undefined
  }

  return counts.failed / counts.total >= above
    ? { reason: 'error-rate', rate: counts, at }
    : undefined
}

/**
 * Whether the application has gone quiet, and for long enough to mean it.
 *
 * The one trigger that fires on an absence. Everything else here watches a
 * number get worse, which means a collector that has stopped reporting — a bad
 * deploy, an intake behind a changed route prefix, a plugin that never
 * loaded — reads exactly like a healthy afternoon, and the silence is
 * interpreted as good news right up until somebody notices by other means.
 *
 * `observedMs` is what keeps it honest. An application that has only ever been
 * watched for ten minutes has not "gone quiet" after twenty; neither has one
 * whose normal traffic is a handful of requests an hour. Without a history to
 * compare against there is nothing to notice a change from, so nothing is
 * claimed — the trigger stays silent rather than guessing, which is the same
 * rule the previous-window comparison follows on the dashboard.
 */
export function evaluateSilence(
  observed: {
    /** When anything — a request or an error — was last recorded. */
    lastSeen: number
    /** How long the database has been collecting. */
    observedMs: number
    /** Requests counted over that history, for judging whether quiet is normal. */
    requests: number
  },
  options: MonitorTriggerOptions | undefined,
  at: number,
): MonitorAlert | undefined {
  const setting = options?.silence

  if (!setting) {
    return undefined
  }

  const after = typeof setting === 'object' ? setting.after ?? DEFAULT_SILENCE_MS : DEFAULT_SILENCE_MS

  /**
   * Enough history to know what normal was.
   *
   * Deliberately a multiple of the threshold rather than a fixed span: a
   * two-hour rule needs more than two hours of history to mean anything, and
   * somebody who sets a ten-minute rule on a busy service should not wait a
   * day for it to arm. The first window after installation is therefore never
   * alerted on, which is right — nothing is known yet.
   */
  if (observed.observedMs < after * MIN_HISTORY_FACTOR) {
    return undefined
  }

  /**
   * Enough traffic that silence is a change rather than the status quo.
   *
   * An internal tool nobody visits overnight is quiet every night, and a
   * trigger that fires on that is an alarm clock. The floor is measured over
   * the whole observed history, so it scales with how long the tool has been
   * watching instead of assuming a busy application.
   */
  if (observed.requests < MIN_SILENCE_REQUESTS) {
    return undefined
  }

  const sinceMs = at - observed.lastSeen

  if (sinceMs < after) {
    return undefined
  }

  return {
    reason: 'silence',
    quietFor: { sinceMs, lastSeen: observed.lastSeen },
    at,
  }
}

/**
 * The highest threshold this issue has just passed and not yet reported.
 *
 * Compared against what was announced rather than against the previous count,
 * so an issue that jumps from 4 to 400 in one flush reports 100 once rather
 * than staying quiet because it never sat at exactly ten.
 */
function crossedThreshold(
  count: number,
  state: IssueState,
  options: MonitorTriggerOptions | undefined,
): number | undefined {
  const thresholds = options?.thresholds ?? DEFAULT_THRESHOLDS

  let crossed: number | undefined

  for (const threshold of thresholds) {
    if (count >= threshold && threshold > state.alertedCount && threshold > state.previousCount) {
      crossed = crossed === undefined ? threshold : Math.max(crossed, threshold)
    }
  }

  return crossed
}
