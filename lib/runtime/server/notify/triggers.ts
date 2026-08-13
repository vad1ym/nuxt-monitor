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

export interface IssueState {
  /** Count before this flush wrote to the issue. `0` for a fingerprint never seen. */
  previousCount: number
  /** Whether the issue was marked resolved before this flush reopened it. */
  wasResolved: boolean
  /** Highest threshold already announced. */
  alertedCount: number
  /** When this issue last raised an alert. `0` for never. */
  alertedAt: number
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
