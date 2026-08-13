import type { MonitorFacetCounts, MonitorFacetName } from '../lib/types'

/**
 * Finding the one thing worth saying about a breakdown.
 *
 * "250 errors" is a number to investigate; "250 errors, 90% of them on iOS 16"
 * is a diagnosis. This picks the slice worth putting into that sentence, or
 * nothing when no slice deserves it — a summary that always claims something
 * teaches people to ignore it.
 */

export interface DominantSlice {
  facet: MonitorFacetName
  value: string
  /**
   * The value as it should be read aloud.
   *
   * A version facet on its own is a bare number — "92% on 15" names nothing —
   * so it is qualified with the browser or OS it belongs to. Filtering still
   * uses `value`; only the sentence uses this.
   */
  label: string
  count: number
  share: number
  /**
   * How much the slice is over-represented against the same facet across all
   * traffic. Undefined when there is no baseline to compare with.
   */
  lift?: number
}

/**
 * Share a slice must reach before it is worth mentioning at all.
 *
 * Below this it is not a pattern, it is the biggest of several similar groups.
 */
const MIN_SHARE = 0.6

/** Too few events and a high share is just small numbers. */
const MIN_COUNT = 5

/**
 * How much more concentrated than the baseline the slice must be.
 *
 * This is the condition that keeps the summary honest. If 90% of an app's
 * traffic is iOS then "90% of errors on iOS" is a description of the audience,
 * not a finding, and stating it as one sends somebody looking for an iOS bug
 * that does not exist. Only a genuine skew is worth a sentence.
 */
const MIN_LIFT = 1.3

/** Facets ordered by how much a finding in them narrows the search. */
/**
 * `kind` and `group` are filterable but absent here on purpose: `kind` has two
 * useful values, so "100% of these are API errors" restates where the code
 * lives, and `group` is a name somebody chose for this issue — reporting it
 * back as a discovery tells them what they already said.
 */
const PRIORITY: MonitorFacetName[] = [
  'browserVersion',
  'osVersion',
  'browser',
  'os',
  'release',
  'deviceType',
  'route',
]

/**
 * A slice covering everything is only a finding for some facets.
 *
 * Most errors are thrown from one place in the code, so "100% on /cart" is a
 * restatement of where the code lives, not a discovery — and left unchecked it
 * outranks the browser skew that is the actual answer. An environment facet at
 * 100% is different: every user hitting it is genuinely on one browser.
 */
const TAUTOLOGICAL_AT_TOTAL: MonitorFacetName[] = ['route', 'release', 'kind', 'group']

/**
 * The most concentrated slice across all facets, if any qualifies.
 *
 * `baseline` is the same facet counts over all traffic in the window; without
 * it a slice is judged on share alone, which is the weaker test.
 */
export function dominantSlice(
  facets: MonitorFacetCounts | null | undefined,
  baseline?: MonitorFacetCounts | null,
): DominantSlice | undefined {
  if (!facets) {
    return undefined
  }

  const candidates: DominantSlice[] = []

  for (const facet of PRIORITY) {
    const top = facets[facet]?.values[0]

    // `unknown` means the facet was never recorded — a real answer for old
    // events, but never an insight.
    if (!top || top.value === 'unknown' || top.count < MIN_COUNT || top.share < MIN_SHARE) {
      continue
    }

    // A single-valued dimension says only that the facet has one value, which
    // is what "where the code lives" looks like for a route.
    if (top.share >= 0.999 && TAUTOLOGICAL_AT_TOTAL.includes(facet)) {
      continue
    }

    const lift = liftOf(facet, top.value, top.share, baseline)

    if (lift !== undefined && lift < MIN_LIFT) {
      continue
    }

    candidates.push({
      facet,
      value: top.value,
      label: labelFor(facet, top.value, facets),
      count: top.count,
      share: top.share,
      lift,
    })
  }

  if (!candidates.length) {
    return undefined
  }

  // Strongest skew first, then the largest share. A facet with no baseline
  // ranks on share alone rather than being pushed below every facet that has
  // one — an unknown skew is not a weak skew. Ties are broken by PRIORITY
  // explicitly rather than by relying on sort stability, so the more specific
  // facet wins for a stated reason.
  return candidates.sort((a, b) =>
    scoreOf(b) - scoreOf(a)
    || b.share - a.share
    || PRIORITY.indexOf(a.facet) - PRIORITY.indexOf(b.facet),
  )[0]
}

/**
 * Ranking weight for a slice.
 *
 * `Infinity` would make every absent-from-baseline slice tie with every other,
 * so it is capped: being unseen in normal traffic is the strongest signal
 * available, but it should still lose to nothing and tie with nothing else.
 */
function scoreOf(slice: DominantSlice): number {
  if (slice.lift === undefined) {
    // No baseline to judge against — fall back to share, on the same scale a
    // lift of 1 would put it on.
    return slice.share
  }

  return Number.isFinite(slice.lift) ? slice.lift : 1_000
}

/** Which facet names a version facet's subject. */
const QUALIFIES: Partial<Record<MonitorFacetName, MonitorFacetName>> = {
  browserVersion: 'browser',
  osVersion: 'os',
}

/**
 * Prefixes a version with what it is a version of.
 *
 * Only when that parent is itself near-unanimous: with a mixed set of browsers
 * behind one version number, naming the most common one would be a guess
 * presented as a fact.
 */
function labelFor(facet: MonitorFacetName, value: string, facets: MonitorFacetCounts): string {
  const parent = QUALIFIES[facet]
  const top = parent ? facets[parent]?.values[0] : undefined

  if (!top || top.value === 'unknown' || top.share < 0.9) {
    return value
  }

  // Already qualified. A version value is usually the bare number, but not
  // always — some agents report "Mobile Safari 15" outright, and prefixing
  // that gives "Mobile Safari Mobile Safari 15", which reads as a parsing bug
  // to anybody who sees it.
  if (value.toLowerCase().startsWith(top.value.toLowerCase())) {
    return value
  }

  // "Mobile Safari 15" rather than "15".
  return `${top.value} ${value}`
}

function liftOf(
  facet: MonitorFacetName,
  value: string,
  share: number,
  baseline: MonitorFacetCounts | null | undefined,
): number | undefined {
  const rows = baseline?.[facet]?.values

  if (!rows?.length) {
    return undefined
  }

  const match = rows.find(row => row.value === value)

  // Absent from the baseline entirely: every occurrence is in a slice that
  // barely appears in normal traffic, which is as skewed as it gets.
  if (!match) {
    return Number.POSITIVE_INFINITY
  }

  return match.share > 0 ? share / match.share : undefined
}

const LABELS: Record<MonitorFacetName, string> = {
  browser: 'browser',
  browserVersion: 'browser version',
  os: 'OS',
  osVersion: 'OS version',
  deviceType: 'device',
  release: 'release',
  route: 'route',
  kind: 'kind',
  group: 'group',
}

export function facetLabel(facet: MonitorFacetName): string {
  return LABELS[facet]
}
