<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MonitorFacetCounts, MonitorFacetFilter } from '../../lib/types'
import type { IssueDetail } from '../api'
import { api } from '../api'
import { formatCount } from '../chart'
import { absoluteTime, formatDuration, relativeTime, statusColor } from '../format'
import { isVendorFrame, packageOf, primaryFrame, shortLocation } from '../frames'
import IssueBreakdown from './IssueBreakdown.vue'
import StackTrace from './StackTrace.vue'
import TimeChart from './LazyTimeChart'

const props = defineProps<{ fingerprint: string }>()
const emit = defineEmits<{
  back: []
  changed: []
  /** Open another issue — the other half of the same failing request. */
  select: [fingerprint: string]
}>()

const detail = ref<IssueDetail | null>(null)
const error = ref('')
const loading = ref(false)
const selected = ref(0)

/** Narrows the breakdown and the occurrences below it to one slice. */
const filter = ref<MonitorFacetFilter>({})

/**
 * How many values each dropdown in the breakdown may show.
 *
 * Undefined leaves it to the server's default. Not reset when the filter
 * changes: someone who opened up a long list is still reading it.
 */
const facetLimit = ref<number | undefined>()

const FACET_PAGE = 20

/**
 * The same facets across all traffic.
 *
 * Fetched once and kept: without it a breakdown cannot tell a real skew from
 * the shape of the audience, and it does not change while an issue is open.
 */
const baseline = ref<MonitorFacetCounts | null>(null)

const current = computed(() => detail.value?.events[selected.value])

const isFiltered = computed(() => Object.keys(filter.value).length > 0)

/**
 * Where to look first — shown in the header rather than left in the trace.
 *
 * Three states, not two, because the interesting one used to be silent. A
 * `FetchError` from `ofetch` has no application frame anywhere in its trace:
 * every line belongs to a dependency, `primaryFrame` falls back to the top of
 * the stack, and the header then said `ofetch/dist/shared/ofetch.mjs:332` in
 * the same confident colour it uses for the reader's own code. That is a true
 * fact and a useless one — the file it names is not where the bug is and not a
 * file anybody can open. Worse, it crowds out the honest answer, which is that
 * the trace does not reach the application and the route in the message is the
 * only location there is.
 */
const location = computed(() => {
  const frame = primaryFrame(current.value?.frames ?? [])

  if (!frame) {
    return undefined
  }

  const inApp = !isVendorFrame(frame)

  return {
    text: shortLocation(frame),
    inApp,
    /**
     * Whether the location survived a sourcemap.
     *
     * Without a map the line counts lines in the built bundle, and `shortPath`
     * trims the bundle URL down to something that looks exactly like a source
     * path — so an unresolved frame reads as a confident, wrong answer.
     */
    mapped: Boolean(frame.original),
    // Named, because "in ofetch" is the part that explains why this is not
    // your file — and it is the search term for finding the call that made it.
    package: inApp ? undefined : packageOf(frame.original?.file ?? frame.file) ?? packageOf(frame.file),
  }
})

/**
 * Every occurrence, described well enough to choose between them.
 *
 * Time alone did not: a run of occurrences seconds apart all render as
 * "5m ago", so the picker offered twenty identical labels. Browser, status and
 * time together are what actually vary, and the first two are also what makes
 * one occurrence worth opening over another.
 *
 * Built for the whole list rather than only the selected one, because stepping
 * through with arrows is the wrong control when the interesting occurrence is
 * the fifth: it has to be walked to blind, one render at a time, with no way to
 * see from the first that the fifth is the one that failed differently. The
 * same labels drive both — the arrows and the list — so they cannot disagree
 * about what an occurrence is called.
 */
const occurrences = computed(() =>
  (detail.value?.events ?? []).map((event, index) => {
    const status = typeof event.context?.statusCode === 'number'
      ? String(event.context.statusCode)
      : undefined

    return {
      index,
      time: relativeTime(event.timestamp),
      absolute: absoluteTime(event.timestamp),
      browser: event.facets?.browser,
      status,
      // The one line the arrows show. Same parts, same order.
      label: [event.facets?.browser, status, relativeTime(event.timestamp)]
        .filter(Boolean)
        .join(' · '),
    }
  }),
)

const occurrenceLabel = computed(() => occurrences.value[selected.value]?.label ?? '')

/**
 * Request details are promoted out of the context list: route, method and
 * status answer "which call broke" before anything else does.
 *
 * On the client the same field means something else, and calling both
 * "Request" was a lie the screen told: a browser error carries the URL of the
 * page it happened on, not the call that failed. A `$fetch` to
 * `/api/checkout/quote` failing on `/cart` was labelled `Request /cart`, which
 * points the reader at the wrong thing entirely — the failing call is in the
 * message, and `/cart` is where the person was standing.
 */
const request = computed(() => {
  const context = current.value?.context ?? {}
  const onClient = detail.value?.issue.side === 'client'

  return {
    label: onClient ? 'Page' : 'Request',
    url: typeof context.url === 'string' ? context.url : undefined,
    // A page has no method or status of its own here — those describe a server
    // request, and showing the page's own navigation status beside a failed
    // `$fetch` would be a third unrelated number.
    method: onClient ? undefined : typeof context.method === 'string' ? context.method : undefined,
    status: onClient ? undefined : typeof context.statusCode === 'number' ? context.statusCode : undefined,
    // How long it ran before it broke. Beside the status because the two are
    // read together: a 500 in 3ms is a rejected input, the same 500 after 30s
    // is something downstream timing out.
    duration: onClient
      ? undefined
      : typeof context.durationMs === 'number'
        ? formatDuration(context.durationMs)
        : undefined,
    // Belongs to this occurrence rather than to the issue, which is why it is
    // rendered down beside the stack and not up among the header facts: every
    // occurrence has a different one, and a value in the header reads as
    // describing all of them.
    id: typeof context.requestId === 'string' ? context.requestId : undefined,
  }
})

/**
 * What was sent and what came back.
 *
 * Given their own section rather than left among the context rows: a body is
 * the one thing beside the stack that tells you *why* the code broke rather
 * than where, and as a `dd` in a two-column list a JSON payload was an
 * unreadable wall wedged between `source` and `info`.
 *
 * Either half may be absent — the request half is off unless configured, and
 * a failure with no payload has no response body — so each is rendered only
 * when it is there.
 */
const bodies = computed(() => {
  const context = current.value?.context ?? {}

  const format = (value: unknown): string | undefined => {
    if (value === undefined || value === null) {
      return undefined
    }

    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }

  return [
    { key: 'request', label: 'Request', value: format(context.requestBody) },
    { key: 'response', label: 'Response', value: format(context.responseBody) },
  ].filter(entry => entry.value !== undefined)
})

const headers = computed(() => {
  const raw = current.value?.context?.headers

  return raw && typeof raw === 'object' ? Object.entries(raw as Record<string, unknown>) : []
})

/**
 * Everything else, minus the fields shown above and the noisy ones.
 *
 * `runtime` joins the skipped list. It is the Node, Nuxt and Nitro versions of
 * the server, which is a fact about the machine rather than about this error —
 * identical on every issue in the database, so as a row on this page it was a
 * constant taking up a heading and never once changing what anybody did. It
 * still travels in the export, where a constant costs nothing.
 *
 * What is left is whatever the application itself attached, which is the only
 * reason this survives at all.
 */
const contextEntries = computed(() => {
  const skip = new Set([
    'url',
    'method',
    'statusCode',
    'durationMs',
    'requestId',
    'headers',
    'userAgent',
    'requestBody',
    'responseBody',
    'runtime',
  ])

  return Object.entries(current.value?.context ?? {})
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => ({
      key,
      value: typeof value === 'object' && value !== null
        ? JSON.stringify(value, null, 2)
        : String(value),
    }))
})

/**
 * The payload panes: what was sent, what came back, what it arrived with.
 *
 * One tabbed block rather than three stretches of page. Side by side the two
 * bodies were sized by the longer of them, so a two-line response next to a
 * twenty-line request left a card-sized hole on the screen — and the headers,
 * which are the same kind of thing, sat somewhere else entirely behind a
 * collapsible. They are all answers to "what did this request actually look
 * like", read one at a time, which is exactly what tabs are for.
 *
 * Headers last and never first: they are the least often wanted of the three,
 * and the tab that opens by default should be the one most visits need.
 */
const payload = computed<{ key: string, label: string, kind: 'body' | 'headers' | 'context', value?: string }[]>(() => {
  const panes: { key: string, label: string, kind: 'body' | 'headers' | 'context', value?: string }[]
    = bodies.value.map(body => ({
      key: body.key,
      label: body.label,
      kind: 'body' as const,
      value: body.value,
    }))

  if (headers.value.length) {
    panes.push({
      key: 'headers',
      label: `Headers (${headers.value.length})`,
      // Rendered as a two-column list rather than as text — a header block
      // pasted into a `pre` is a wall, and the pairs are what carry meaning.
      kind: 'headers',
    })
  }

  // Last, and usually absent. Everything this tool records itself is shown
  // somewhere better on this page, so what reaches here is what the
  // application attached to its own error — rare, and worth keeping a home
  // for rather than dropping on the floor with the section that used to
  // display the runtime versions.
  if (contextEntries.value.length) {
    panes.push({ key: 'context', label: 'Context', kind: 'context' })
  }

  return panes
})

/** Which payload pane is open. */
const pane = ref('')

/**
 * The open pane, falling back to the first that exists.
 *
 * Held by key rather than by index so a choice survives stepping to the next
 * occurrence: the panes are rebuilt per occurrence and one may have no request
 * body, so an index would quietly show a different thing than the one that was
 * picked. A key that no longer matches falls back rather than rendering blank.
 */
const currentPane = computed(() =>
  payload.value.find(entry => entry.key === pane.value) ?? payload.value[0],
)

/**
 * The trail as a timeline rather than a table of three columns.
 *
 * A list of `FETCH · POST /api/checkout/quote → 500 · 12h ago` rows makes the
 * reader parse every line to find the one that matters — every row looks the
 * same weight, and "12h ago" repeated eight times says nothing about the order
 * of events it is supposed to establish. What a person actually wants from
 * this section is: what kind of thing was this, did it go wrong, and how long
 * before the error did it happen. So each of those gets its own channel — an
 * icon and colour for the kind, a red tint for a failed call, and an offset
 * measured back from the crash instead of a wall clock.
 */
const CRUMB_KINDS = {
  navigation: { icon: 'i-lucide-corner-down-right', color: 'text-primary', label: 'Navigated' },
  fetch: { icon: 'i-lucide-arrow-up-down', color: 'text-info', label: 'Request' },
  click: { icon: 'i-lucide-mouse-pointer-click', color: 'text-toned', label: 'Clicked' },
  console: { icon: 'i-lucide-terminal', color: 'text-muted', label: 'Console' },
} as const

const timeline = computed(() => {
  const crumbs = current.value?.breadcrumbs ?? []

  /**
   * What the offsets are measured back from.
   *
   * The error's own timestamp is the honest anchor and the one to prefer, but
   * it cannot be trusted to be the latest thing here: a crumb is recorded in
   * the browser and the error may be stamped on a different clock or by a
   * queued batch, and seed data disagrees by half an hour. When that happens
   * every row renders "after", which is worse than useless — it is a column of
   * one repeated word where the sequence should be. Falling back to the last
   * crumb keeps the gaps between steps, which is the part that reads.
   */
  const errorAt = current.value?.timestamp
  const lastCrumb = crumbs.length ? crumbs[crumbs.length - 1]!.timestamp : undefined
  const crashedAt = errorAt !== undefined && (lastCrumb === undefined || errorAt >= lastCrumb)
    ? errorAt
    : lastCrumb

  return crumbs.map((crumb, index) => {
    const kind = CRUMB_KINDS[crumb.type] ?? CRUMB_KINDS.console

    // Read off the crumb's own message rather than its data, because that is
    // the one field every source fills in — a status arrives in `data` from
    // the browser's own fetch wrapper, but a crumb forwarded from anywhere
    // else only ever has the sentence.
    const status = typeof crumb.data?.status === 'number'
      ? crumb.data.status
      : Number(/→\s*(\d{3})\b/.exec(crumb.message)?.[1]) || undefined

    const failed = crumb.type === 'fetch'
      && (status === undefined ? /→\s*failed\b/.test(crumb.message) : status >= 400)

    return {
      index,
      icon: kind.icon,
      label: kind.label,
      color: failed ? 'text-error' : kind.color,
      failed,
      status,
      message: crumb.message,
      ms: typeof crumb.data?.ms === 'number' ? crumb.data.ms : undefined,
      // How long before the crash, which is the only reading of these times
      // anybody does. Absolute time stays on the title for the rare case.
      offset: crashedAt !== undefined ? beforeCrash(crumb.timestamp, crashedAt) : undefined,
      title: absoluteTime(crumb.timestamp),
    }
  })
})

/**
 * "2.4s before" — the distance from a crumb to the error.
 *
 * Sub-second resolution near the crash, because that is where the interesting
 * gaps are: a request that returned 40ms before the throw is a different story
 * from one that returned four seconds before it, and both render as "12h ago".
 */
function beforeCrash(timestamp: number, crashedAt: number): string {
  const ms = crashedAt - timestamp

  if (ms < 0) {
    return 'after'
  }

  // The step the anchor itself sits on. "0ms before" is a label pretending to
  // be a measurement.
  if (ms === 0) {
    return ''
  }

  if (ms < 1_000) {
    return `${ms}ms before`
  }

  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s before`
  }

  return ms < 3_600_000 ? `${Math.round(ms / 60_000)}m before` : `${Math.round(ms / 3_600_000)}h before`
}

/**
 * How much of the damage this one issue accounts for.
 *
 * Shown only when it is worth a slot: a lone session says nothing about
 * spread, and 100% of a denominator of one is a fraction pretending to be a
 * finding. The wording says "of sessions with errors" rather than "of users",
 * because that is what the denominator is — visitors are counted without a
 * session id, so a share of everybody is not available and would be a
 * confident number meaning nothing.
 */
const affected = computed(() => {
  const share = detail.value?.sessionShare

  // Two guards, for two different kinds of nothing. A denominator of one is
  // not a distribution; and a share of 100% means no other issue overlapped
  // this one's span at all, so the fraction is comparing the issue against
  // itself. Both render as a confident percentage that carries no information,
  // which is worse than an absent row — the reader spends attention on it.
  if (!share || share.total < 2 || share.affected >= share.total) {
    return undefined
  }

  return {
    affected: share.affected,
    total: share.total,
    percent: Math.round((share.affected / share.total) * 100),
  }
})

/**
 * A fix that did not hold.
 *
 * The most valuable sentence this tool has, and until now it existed only
 * inside a single alert: `resolved` is a boolean, so the occurrence that
 * reopened the issue also erased the fact that anybody had ever called it
 * fixed. The page then looked exactly like an issue nobody had touched.
 *
 * The gap is the content. An hour after the fix means the fix was wrong; three
 * weeks later means something else broke the same way, and those are different
 * afternoons.
 */
const regression = computed(() => {
  const issue = detail.value?.issue
  const resolvedAt = issue?.resolvedAt
  const regressedAt = issue?.regressedAt

  // Both, and in that order. A resolved issue that has not come back is not a
  // regression, and a `regressedAt` without its claim has nothing to measure
  // the gap against.
  if (!issue || issue.resolved || !resolvedAt || !regressedAt || regressedAt <= resolvedAt) {
    return undefined
  }

  return {
    at: regressedAt,
    resolvedAt,
    gap: describeGap(regressedAt - resolvedAt),
    title: `Marked resolved ${absoluteTime(resolvedAt)}, happened again ${absoluteTime(regressedAt)}`,
  }
})

/** "2 hours" / "3 days" — the distance between the claim and its refutation. */
function describeGap(ms: number): string {
  const minutes = Math.round(ms / 60_000)

  if (minutes < 60) {
    return `${Math.max(1, minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 48) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }

  return `${Math.round(hours / 24)} days`
}

/**
 * The other issues from the same request as the occurrence being shown.
 *
 * Empty for anything with no correlation id behind it — an error thrown by no
 * request at all, or one stored before ids were kept — which is why the panel
 * disappears rather than saying "none".
 */
const related = computed(() => detail.value?.related ?? [])

const trend = computed(() => detail.value?.trend)

/**
 * Deploys drawn on this issue's own timeline.
 *
 * The header already says which releases the issue spans, and that is a
 * different fact: "introduced in 1.8.2, last seen in 1.8.4" says it survived
 * three releases, not whether the last one ended it. A line on the chart puts
 * the deploy next to the shape, which is the only place the answer lives — the
 * occurrences either stop at the line or they do not.
 *
 * Hidden under a filter. The chart is then drawn from a subset of occurrences
 * and its axis no longer spans what it did, so a marker placed by absolute
 * time would sit against a line that means something narrower than it claims.
 */
/**
 * The release the chart was pulled back to, when it was.
 *
 * Only when the axis actually starts before the first occurrence — otherwise
 * there is no run-up to explain, and a note about one would describe something
 * not on screen. The deploy at that edge is the one it was pulled back to.
 */
const leadIn = computed(() => {
  const start = trend.value?.points[0]?.at
  const firstSeen = detail.value?.issue.firstSeen

  if (start === undefined || firstSeen === undefined || start >= firstSeen) {
    return undefined
  }

  const deploy = detail.value?.deploys?.find(entry => entry.at <= firstSeen)

  return deploy
    ? {
        release: deploy.release,
        title: `Drawn from ${deploy.release}, the release running when this issue first appeared — the flat stretch before the first error is not a quiet period, it is before the issue existed`,
      }
    : undefined
})

const deploys = computed(() =>
  isFiltered.value
    ? []
    : (detail.value?.deploys ?? []).map(deploy => ({
        at: deploy.at,
        label: deploy.release,
        // Explicit rather than left off, so this array and the resolve and
        // regression moments pushed onto it below share one type.
        tone: 'neutral' as const,
        title: deploy.newIssues
          ? `${deploy.release} — first seen here: ${deploy.newIssues} new ${deploy.newIssues === 1 ? 'issue' : 'issues'} across the app`
          : `${deploy.release} — nothing new appeared`,
      })),
)

/**
 * Everything drawn as a vertical line: deploys, and the fix that did not hold.
 *
 * The two moments belong on the same axis for the same reason a deploy does —
 * "it went quiet, then it came back" is a statement about the shape either
 * side of an instant, and no sentence above the chart lets anybody see that.
 * Together they answer the question the banner only asserts.
 *
 * Only when they fall inside the drawn span. A resolve from before the oldest
 * surviving occurrence has no x-position here and would be pinned to the left
 * edge, marking the start of the axis rather than a moment on it.
 */
const markers = computed(() => {
  const points = trend.value?.points ?? []
  const start = points[0]?.at
  const end = points.at(-1)?.at

  if (start === undefined || end === undefined) {
    return deploys.value
  }

  const span = end + (trend.value?.step ?? 0)
  const inside = (at: number): boolean => at >= start && at <= span
  const moments = [...deploys.value]
  const issue = detail.value?.issue

  // Marked with a glyph rather than a word, and coloured, unlike the deploys.
  // These are the two moments a person acted on and the chart's whole argument
  // about whether the fix held — but "resolved" and "came back" written out are
  // wide enough to collide with each other and with a release name, which on
  // an issue resolved and regressed minutes apart is exactly what happened. A
  // tick and a loop are the same statement in a fraction of the width, and the
  // tooltip still spells it out.
  if (!isFiltered.value && issue?.resolvedAt && inside(issue.resolvedAt)) {
    moments.push({
      at: issue.resolvedAt,
      label: '✓',
      tone: 'success' as const,
      title: `Marked resolved ${absoluteTime(issue.resolvedAt)}`,
    })
  }

  if (!isFiltered.value && issue?.regressedAt && inside(issue.regressedAt)) {
    moments.push({
      at: issue.regressedAt,
      label: '↺',
      tone: 'warning' as const,
      title: `Happened again ${absoluteTime(issue.regressedAt)}, after being marked resolved`,
    })
  }

  return moments.sort((a, b) => a.at - b.at)
})

const trendSeries = computed(() => [{
  name: 'occurrences',
  values: trend.value?.points.map(point => point.count) ?? [],
  color: detail.value?.issue.side === 'client' ? 'var(--ui-info)' : 'var(--ui-warning)',
}])

/**
 * Whether the chart covers the whole life of the issue.
 *
 * Occurrences are trimmed per issue, so a busy one keeps recent history rather
 * than all of it. Drawing that as though it were everything would put the
 * issue's beginning at whatever the oldest surviving row happens to be, and a
 * fault that has run for a week would read as one that started this morning.
 */
const trendPartial = computed(() =>
  Boolean(trend.value && !isFiltered.value && trend.value.stored < (detail.value?.issue.count ?? 0)),
)

/**
 * How often it happens, over the span it happened in.
 *
 * Measured from first to last occurrence rather than "per hour since it
 * started": an issue that fired 200 times in a minute and never again is not
 * happening three times an hour, and averaging it over the silence since would
 * say exactly that.
 */
const rate = computed(() => {
  const issue = detail.value?.issue

  if (!issue || issue.count < 2) {
    return undefined
  }

  const spanMs = issue.lastSeen - issue.firstSeen

  // Everything inside one instant is a burst, not a rate.
  if (spanMs < 60_000) {
    return undefined
  }

  const perHour = issue.count / (spanMs / 3_600_000)

  if (perHour >= 1) {
    return `${formatCount(Math.round(perHour))}/hour`
  }

  const perDay = perHour * 24

  return perDay >= 1 ? `${formatCount(Math.round(perDay))}/day` : 'less than once a day'
})

async function load({ keepSelection = false } = {}): Promise<void> {
  loading.value = true
  error.value = ''

  try {
    detail.value = await api.issue(props.fingerprint, filter.value, facetLimit.value)

    // The filter changes which occurrences exist, so an index into the old
    // list would point at the wrong one — or at nothing. Widening a facet
    // dropdown does not: the occurrences are the same ones, and resetting
    // would throw away the trace the reader is looking at.
    if (!keepSelection) {
      selected.value = 0
    }
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not load this issue'
  }
  finally {
    loading.value = false
  }
}

/** Another page of values in the breakdown's dropdowns. */
async function expandFacets(): Promise<void> {
  facetLimit.value = (facetLimit.value ?? FACET_PAGE) + FACET_PAGE
  await load({ keepSelection: true })
}

/**
 * What the audience looks like, for judging this issue's breakdown against.
 *
 * Taken from counted page views, not from the facets of other errors. Those
 * two were the same call until traffic facets existed, and the difference is
 * the whole point of the comparison: measured against other errors, "90% of
 * these are on Chrome" is confirmed by whichever browser is noisiest, and the
 * one-line summary restated the shape of the error table rather than saying
 * anything about this issue.
 *
 * Falls back to the error facets when no page views were counted — a fresh
 * install, or an API-only application. A weaker baseline is still better than
 * ranking slices by share alone, which has no notion of over-representation.
 */
async function loadBaseline(): Promise<void> {
  try {
    const answer = await api.facets(undefined, 24, undefined, true)
    const counted = Object.values(answer.traffic ?? {}).some(group => group.values.length > 0)

    baseline.value = counted ? answer.traffic! : answer.facets
  }
  catch {
    // Failure here costs the comparison, not the page.
    baseline.value = null
  }
}

async function toggleResolved(): Promise<void> {
  if (!detail.value) {
    return
  }

  detail.value.issue = await api.setResolved(props.fingerprint, !detail.value.issue.resolved)
  emit('changed')
}

async function toggleIgnored(): Promise<void> {
  if (!detail.value) {
    return
  }

  detail.value.issue = await api.setIgnored(props.fingerprint, !detail.value.issue.ignored)
  emit('changed')
}

watch(() => props.fingerprint, () => {
  // A filter from the previous issue rarely applies to the next one, and
  // landing on an empty issue looks like a missing issue. Assigning a fresh
  // object would also wake the filter watcher below and load twice, so the
  // reset only happens when there is something to reset.
  if (Object.keys(filter.value).length) {
    filter.value = {}
    return
  }

  void load()
}, { immediate: true })

// Wrapped rather than passed directly: a watcher hands its callback the new
// value, which would arrive as `load`'s options object and let a facet named
// `keepSelection` decide whether the selection resets.
watch(filter, () => void load(), { deep: true })

onMounted(loadBaseline)
</script>

<template>
  <div class="space-y-5">
    <!-- Only while there is nothing else to attach it to. Once the issue has
         loaded the same link rides along the badge row, where it costs no
         vertical space of its own — but a load that is still running or has
         failed still needs a way back to the list. -->
    <UButton
      v-if="!detail || loading"
      variant="link"
      color="neutral"
      size="sm"
      icon="i-lucide-arrow-left"
      label="All issues"
      class="ps-0"
      @click="emit('back')"
    />

    <div v-if="loading" class="space-y-3">
      <USkeleton class="h-8 w-72" />
      <USkeleton class="h-32 w-full" />
    </div>

    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      :title="error"
      icon="i-lucide-triangle-alert"
    />

    <template v-else-if="detail">
      <!-- `space-y-2`, not 3: the identity line and the measurements under it
           describe the same thing and should read as one block under the
           title, not as two more sections. -->
      <header class="space-y-2">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-xs">
              <!-- On the badge row rather than on a line of its own above it.
                   Alone it claimed a full row plus the gap under it to hold
                   two words, and the row it now shares was half empty. -->
              <UButton
                variant="link"
                color="neutral"
                size="xs"
                icon="i-lucide-arrow-left"
                label="All issues"
                class="ps-0 -ms-0.5"
                @click="emit('back')"
              />

              <UBadge
                :color="detail.issue.side === 'client' ? 'info' : 'warning'"
                variant="subtle"
                size="sm"
                :label="detail.issue.side"
              />
              <!-- A manual report's type is always `MonitorException`. What
                   the caller named — the group and the level — is the part
                   that carries information, so it takes the slot. -->
              <UBadge
                v-if="detail.issue.manual"
                color="primary"
                variant="subtle"
                size="sm"
                icon="i-lucide-flag"
                :label="detail.issue.group
                  ? `${detail.issue.group}${detail.issue.level ? ` · ${detail.issue.level}` : ''}`
                  : `exception()${detail.issue.level ? ` · ${detail.issue.level}` : ''}`"
                title="Raised by exception(), not thrown"
              />

              <span v-else class="font-medium text-muted">{{ detail.issue.type }}</span>
              <UBadge
                v-if="detail.issue.resolved"
                color="success"
                variant="subtle"
                size="sm"
                label="resolved"
              />
              <UBadge
                v-if="detail.issue.ignored"
                color="neutral"
                variant="subtle"
                size="sm"
                label="ignored"
              />
            </div>

            <!-- The one line that says what broke, and it should win the page.
                 At `text-lg` in the same weight as body copy it was outranked
                 by its own supporting chips: a row of bordered boxes has more
                 visual weight than an unemphasised sentence, however large the
                 sentence is. Bigger, heavier, and tighter-set fixes that.

                 Still monospace: these are messages full of paths, quoted
                 identifiers and status codes, and a proportional face turns
                 `"/api/medicines?country_slug=spain"` into something you have
                 to read twice. -->
            <h1 class="mt-2 font-mono text-xl font-semibold leading-tight tracking-tight text-highlighted break-words">
              {{ detail.issue.message }}
            </h1>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <!-- Two different claims, so two buttons. "Resolve" says it was
                 fixed; "Ignore" says it is not ours to fix — an extension, a
                 bot, someone else's script. With only the first, the way to
                 quiet noise was to call it fixed, which makes the resolved
                 list a record of work that never happened. -->
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              :icon="detail.issue.ignored ? 'i-lucide-bell' : 'i-lucide-bell-off'"
              :label="detail.issue.ignored ? 'Unignore' : 'Ignore'"
              @click="toggleIgnored"
            />

            <UButton
              size="sm"
              :color="detail.issue.resolved ? 'neutral' : 'primary'"
              variant="subtle"
              :icon="detail.issue.resolved ? 'i-lucide-rotate-ccw' : 'i-lucide-check'"
              :label="detail.issue.resolved ? 'Reopen' : 'Resolve'"
              @click="toggleResolved"
            />
          </div>
        </div>

        <!-- The facts you want before reading any code, in two tiers.

             As one row of seven identically-bordered chips they were unrankable:
             a box around every fact gives them all the same weight, so the
             location of the bug and the number of releases it spans competed as
             equals — and the numbers carried no labels, only an icon each, so
             `1 ms`, `29 · 16/day` and `from 1.8.0 → dev` had to be decoded
             rather than read.

             So: the two facts that say *what broke* keep a box and stay on the
             line under the title, and the four that *measure* it become
             labelled values on a quiet second line. A label costs a word and
             saves the decoding. -->
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <!-- Where the fault is, when the trace actually reaches the
               application. Otherwise the honest version below. -->
          <span
            v-if="location?.inApp"
            class="inline-flex items-center gap-1.5 rounded-md border border-default bg-elevated/30 px-2 py-1"
            :title="location.mapped
              ? 'The topmost frame in your own code'
              : 'No sourcemap covered this frame, so the line is a position in the built bundle'"
          >
            <UIcon name="i-lucide-code" class="size-3.5 shrink-0 text-dimmed" />
            <span class="font-mono text-xs" :class="location.mapped ? 'text-primary' : 'text-muted'">
              {{ location.text }}
            </span>
            <span v-if="!location.mapped" class="text-xs text-dimmed">in bundle</span>
          </span>

          <!-- A trace that never reaches your code.
               `ofetch` throwing a `FetchError` is the common case: every frame
               belongs to a dependency, so there is no file of yours to name.
               Saying that plainly beats naming the dependency's own bundled
               file in the colour reserved for your code — which is a confident
               pointer at something nobody can open or fix. The route in the
               title is the real location, and it is already on screen. -->
          <span
            v-else-if="location"
            class="inline-flex items-center gap-1.5 rounded-md border border-dashed border-muted px-2 py-1"
            :title="`The stack stops inside ${location.package ?? 'a dependency'} — no frame in your own code was captured. The failing call is named in the message above; search your code for the route to find where it is made.`"
          >
            <UIcon name="i-lucide-package" class="size-3.5 shrink-0 text-dimmed" />
            <span class="text-xs text-muted">
              Thrown inside <span class="font-mono">{{ location.package ?? 'a dependency' }}</span>
              — no frame of yours
            </span>
          </span>

          <!-- The request as one badge, coloured by how it ended — the same
               shape the list uses, so the row somebody clicked and the header
               they land on describe the call the same way. The duration rides
               inside it rather than in a chip of its own: how long a call ran
               is part of how it failed, and a 500 in 3ms is a rejected input
               where the same 500 after 30s is something downstream timing
               out. -->
          <UBadge
            v-if="request.url"
            :color="request.status ? statusColor(request.status) : 'neutral'"
            variant="subtle"
            size="md"
            class="max-w-full"
            :title="request.label"
          >
            <span class="truncate font-mono">
              <span v-if="request.method" class="opacity-70">{{ `${request.method} ` }}</span>{{ request.url }}<span
                v-if="request.status"
              >{{ ` → ${request.status}` }}</span>
            </span>
            <span
              v-if="request.duration"
              class="ms-1.5 shrink-0 opacity-60"
              title="How long the request had been running when it failed"
            >{{ request.duration }}</span>
          </UBadge>
        </div>

        <!-- The measurements, labelled.
             No borders here on purpose: these are read once to size up the
             problem, not aimed at, and seven boxes competing with the title is
             what made the header unreadable. The label is dimmed and the value
             is not, so the row scans as values with their names attached. -->
        <dl class="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-xs">
          <div class="flex items-baseline gap-1.5">
            <dt class="text-dimmed">
              Occurrences
            </dt>
            <!-- Under a filter the total would contradict everything below it,
                 so it becomes "matching of total". -->
            <dd class="text-toned tabular-nums">
              <template v-if="isFiltered">{{ detail.eventCount }} of </template>{{ detail.issue.count }}
              <!-- The count alone cannot separate "200 times last Tuesday"
                   from "200 times a day, still going". -->
              <span v-if="rate" class="text-dimmed">· {{ rate }}</span>
            </dd>
          </div>

          <!-- The count above says how loud; this says how wide. Twelve
               occurrences across one session is somebody stuck in a retry
               loop; twelve across twelve is everybody hitting it once. -->
          <div
            v-if="affected"
            class="flex items-baseline gap-1.5"
            :title="`${affected.affected} of the ${affected.total} sessions that saw any error while this issue was happening. Not a share of all visitors — page views are counted without a session id.`"
          >
            <dt class="text-dimmed">
              Sessions
            </dt>
            <dd class="text-toned tabular-nums">
              {{ affected.affected }}
              <span class="text-dimmed">· {{ affected.percent }}% of those with errors</span>
            </dd>
          </div>

          <!-- The release, not just the timestamp. "Introduced in 1.8.2" is the
               sentence somebody wants before reading a line of the stack: it
               says whether a deploy caused this, and whether the one after it
               fixed it. A timestamp only answers that for whoever has the
               deploy log open. -->
          <div
            v-if="detail.releases?.first"
            class="flex items-baseline gap-1.5"
            :title="detail.releases.partial
              ? 'Older occurrences have been trimmed, so this is the earliest release still stored — not necessarily where it began'
              : 'The release its first occurrence carried'"
          >
            <dt class="text-dimmed">
              {{ detail.releases.partial ? 'Seen in' : 'Introduced in' }}
            </dt>
            <dd class="font-mono text-toned">
              {{ detail.releases.first }}
              <!-- Only when it has moved on. Repeating the same name twice
                   under two headings says nothing and reads as two facts. -->
              <!-- Spelled out inside the interpolation, not left to whitespace
                   between tags: Vue trims that, so `dev` ran straight into the
                   `·` that follows it. -->
              <span
                v-if="detail.releases.last && detail.releases.last !== detail.releases.first"
                class="text-dimmed"
              >{{ `→ ${detail.releases.last} ` }}</span>
              <span
                v-if="detail.releases.count > 2"
                class="font-sans text-dimmed"
              >{{ `· ${detail.releases.count} releases` }}</span>
            </dd>
          </div>

          <!-- Both times under one label. They are read as a span — "started
               five hours ago, still going two hours ago" is one sentence, and
               as two separate labelled fields it was two lookups. -->
          <div class="flex items-baseline gap-1.5">
            <dt class="text-dimmed">
              Last seen
            </dt>
            <dd class="text-toned">
              <span :title="absoluteTime(detail.issue.lastSeen)">{{ relativeTime(detail.issue.lastSeen) }}</span>
              <span class="text-dimmed" :title="`First seen ${absoluteTime(detail.issue.firstSeen)}`">
                · first {{ relativeTime(detail.issue.firstSeen) }}
              </span>
            </dd>
          </div>
        </dl>

        <!-- The other half of the same incident.
             One failing request usually leaves two rows on two screens: the
             endpoint's 500 here, and the browser's "Cannot read properties of
             undefined" under client errors, thrown by the component that
             received the answer. Read apart they are two mysteries; read
             together the second one explains itself.

             On its own line rather than in the row of chips: it is the only one
             of these facts that is a link, and a target you can click should
             not be indistinguishable from seven that you cannot. -->
        <div v-if="related.length" class="space-y-1">
          <p class="text-xs text-dimmed">
            Same request
          </p>
          <button
            v-for="item in related"
            :key="item.fingerprint"
            type="button"
            class="flex w-full items-center gap-2 rounded-md border border-default px-2 py-1 text-start text-toned hover:border-primary/50 hover:text-primary cursor-pointer"
            @click="emit('select', item.fingerprint)"
          >
            <UIcon name="i-lucide-link" class="size-3.5 shrink-0 text-dimmed" />
            <UBadge
              :color="item.side === 'client' ? 'info' : 'warning'"
              variant="subtle"
              size="sm"
              :label="item.side"
            />
            <span class="font-mono text-xs">{{ item.type }}</span>
            <span class="truncate text-xs text-dimmed">{{ item.message }}</span>
          </button>
        </div>
      </header>

      <!-- The two one-line findings, side by side on a wide screen.
           Each is a single sentence in a bordered strip, and stacked they made
           two full-width rules across the page before the reader reached
           anything they came for. They are also read together: "this came back
           after a fix" and "72% of it is on one release" are the same
           question — what changed — answered from two directions. -->
      <!-- Flex rather than grid, and `empty:hidden`.
           Either child may be absent — there is often no regression, and the
           breakdown renders nothing when it has no finding to state — and an
           empty grid still takes the page's vertical rhythm with it, leaving a
           gap where a banner was not. Flex lets each present child take half
           the row and the whole of it when it is alone. -->
      <div class="flex flex-col gap-3 empty:hidden lg:flex-row [&>*]:flex-1 [&>*]:min-w-0">
        <!-- The one thing on this page that contradicts a person on the
             record. Loud enough to be read before the stack, because it
             changes what the stack means: this is not a new bug, it is the
             same bug outliving a fix, and the interesting question moved from
             "what breaks" to "why did the fix not hold". -->
        <div
          v-if="regression"
          class="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5"
          :title="regression.title"
        >
          <UIcon name="i-lucide-rotate-ccw" class="mt-0.5 size-4 shrink-0 text-warning" />

          <!-- One paragraph rather than three flex items. As separate items
               the sentence broke between them, so "Regression" sat alone on a
               line above its own explanation while the panel beside it stayed
               one line — two boxes of visibly different height saying one
               sentence each. -->
          <p class="text-sm text-toned">
            <strong class="font-semibold text-warning">Regression</strong>
            <span class="text-dimmed">
              · marked resolved {{ relativeTime(regression.resolvedAt) }}, happened again
              {{ regression.gap }} later
            </span>
          </p>
        </div>

        <!-- The conclusion only. One line, and it frames the stack below it —
             the table it used to drag along now sits at the foot of the page. -->
        <IssueBreakdown
          v-model:filter="filter"
          finding-only
          :facets="detail.facets"
          :baseline="baseline"
          :session-count="detail.sessionCount"
          :event-count="detail.eventCount"
          :loading="loading"
        />
      </div>

      <div v-if="!detail.events.length" class="py-10 text-center">
        <p class="text-sm text-muted">
          No occurrences match this filter.
        </p>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          label="Clear filters"
          class="mt-2"
          @click="filter = {}"
        />
      </div>

      <!-- Arrows to walk, a list to jump.
           The arrows alone made the fifth occurrence expensive to reach and
           impossible to aim for: each step is a render, and nothing on screen
           said which of the twenty was the one that failed differently. The
           list shows every label at once, so the odd one out can be picked
           rather than found. -->
      <div v-else-if="detail.events.length > 1" class="flex flex-wrap items-center gap-2">
        <!-- Two buttons with a gap, not a joined group. Fused, the pair reads
             as one wide control with a seam down it, and the seam is where the
             eye looks for a divider between two things — but there is only one
             thing here, stepping. Apart, each is plainly its own target. -->
        <div class="flex items-center gap-1">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-left"
            aria-label="Previous occurrence"
            :disabled="selected === 0"
            @click="selected--"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-right"
            aria-label="Next occurrence"
            :disabled="selected >= detail.events.length - 1"
            @click="selected++"
          />
        </div>

        <UPopover>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            trailing-icon="i-lucide-chevron-down"
            class="px-1"
          >
            <span class="text-sm text-toned">
              <span class="tabular-nums">{{ selected + 1 }} of {{ detail.events.length }}</span>
              <span v-if="occurrenceLabel" class="text-dimmed"> · {{ occurrenceLabel }}</span>
            </span>
          </UButton>

          <template #content>
            <!-- Capped in height rather than in length: an issue with two
                 hundred stored occurrences should still offer all of them,
                 and a list that silently stopped at ten would hide exactly
                 the outlier this control exists to find. -->
            <ul class="max-h-80 w-72 overflow-auto p-1">
              <li v-for="item in occurrences" :key="item.index">
                <button
                  type="button"
                  class="w-full flex items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors cursor-pointer"
                  :class="item.index === selected
                    ? 'text-highlighted bg-elevated/60'
                    : 'text-toned hover:bg-elevated/40'"
                  :aria-pressed="item.index === selected"
                  :title="item.absolute"
                  @click="selected = item.index"
                >
                  <span class="w-6 shrink-0 text-end tabular-nums text-dimmed">{{ item.index + 1 }}</span>
                  <span class="truncate">{{ item.browser }}</span>
                  <span v-if="item.status" class="shrink-0 font-mono text-dimmed">{{ item.status }}</span>
                  <span class="ms-auto shrink-0 text-dimmed">{{ item.time }}</span>
                </button>
              </li>
            </ul>
          </template>
        </UPopover>

        <UButton
          v-if="selected !== 0"
          size="xs"
          color="neutral"
          variant="ghost"
          label="Latest"
          @click="selected = 0"
        />

        <!-- The one value that leaves this screen. Everything else here is
             read; this is copied — into a log query, into a proxy's access log,
             into a message to whoever owns the service that failed. Rendered
             selectable for that reason, and pushed to the end of the picker's
             own row: it describes the occurrence the picker selects, and as a
             line of its own underneath it made two rows of chrome out of one
             control and one value. -->
        <span v-if="request.id" class="ms-auto flex items-center gap-2 text-xs">
          <span class="text-dimmed">Request ID</span>
          <code class="select-all font-mono text-toned">{{ request.id }}</code>
        </span>
      </div>

      <template v-if="current">
        <!-- The same value when there is only one occurrence, and so no picker
             above to carry it. -->
        <p v-if="request.id && detail.events.length === 1" class="flex items-center gap-2 text-xs">
          <span class="text-dimmed">Request ID</span>
          <code class="select-all font-mono text-toned">{{ request.id }}</code>
        </p>

        <section>
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
            Stack
          </h2>
          <StackTrace :frames="current.frames" :raw="current.stack" />
        </section>

        <!-- Directly under the stack, because that is the reading order: the
             trace says where, the payload says what with.

             One block with tabs, rather than two panes side by side and the
             headers somewhere below behind a collapsible. Sized by the longer
             body, the pair left a card-sized hole whenever one was short — and
             all three are answers to the same question, read one at a time. -->
        <section v-if="payload.length">
          <div class="mb-2 flex flex-wrap items-center gap-1">
            <button
              v-for="entry in payload"
              :key="entry.key"
              type="button"
              class="rounded-md px-2 py-1 text-xs font-medium uppercase tracking-wide transition-colors cursor-pointer"
              :class="entry.key === currentPane?.key
                ? 'bg-elevated text-highlighted'
                : 'text-dimmed hover:bg-elevated/50 hover:text-toned'"
              :aria-pressed="entry.key === currentPane?.key"
              @click="pane = entry.key"
            >
              {{ entry.label }}
            </button>
          </div>

          <pre
            v-if="currentPane?.kind === 'body'"
            class="max-h-96 overflow-auto rounded-lg border border-default bg-elevated/30 p-3 text-xs leading-relaxed text-toned"
          >{{ currentPane.value }}</pre>

          <dl
            v-else-if="currentPane?.kind === 'headers'"
            class="grid max-h-96 grid-cols-[minmax(8rem,max-content)_1fr] gap-x-4 gap-y-1 overflow-auto rounded-lg border border-default bg-elevated/30 p-3 text-xs"
          >
            <template v-for="[key, value] in headers" :key="key">
              <dt class="font-mono text-dimmed">
                {{ key }}
              </dt>
              <dd class="font-mono break-all text-muted">
                {{ value }}
              </dd>
            </template>
          </dl>

          <dl
            v-else-if="currentPane"
            class="grid max-h-96 grid-cols-[minmax(8rem,max-content)_1fr] gap-x-4 gap-y-1.5 overflow-auto rounded-lg border border-default bg-elevated/30 p-3 text-xs"
          >
            <template v-for="entry in contextEntries" :key="entry.key">
              <dt class="font-mono text-dimmed">
                {{ entry.key }}
              </dt>
              <dd class="font-mono break-words whitespace-pre-wrap text-toned">
                {{ entry.value }}
              </dd>
            </template>
          </dl>
        </section>

        <!-- A rail with the error at its end, so the trail reads as a sequence
             running into the crash rather than as four columns of text. -->
        <section v-if="timeline.length">
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
            Leading up to it
          </h2>

          <ol class="relative space-y-px">
            <!-- The thread the markers sit on. Behind them and stopping at the
                 last one, so it reads as a path with an end. -->
            <span class="absolute inset-y-3 start-[0.6875rem] w-px bg-default" aria-hidden="true" />

            <li
              v-for="step in timeline"
              :key="step.index"
              class="relative flex items-baseline gap-3 rounded py-1 pe-2 ps-1 text-sm hover:bg-elevated/30"
            >
              <!-- Kind carried by an icon rather than a word: four repeated
                   labels down the left edge is a column of noise, and the eye
                   picks a shape out of a list faster than it reads. -->
              <span
                class="grid size-[1.375rem] shrink-0 place-items-center rounded-full border border-default bg-default"
                :class="step.failed ? 'border-error/40' : ''"
                :title="step.label"
              >
                <UIcon :name="step.icon" class="size-3" :class="step.color" />
              </span>

              <span class="min-w-0 flex-1 break-all" :class="step.failed ? 'text-error' : 'text-toned'">
                {{ step.message }}
              </span>

              <!-- How long it took, where that is known. A call that returned
                   in 4s before a timeout-shaped failure is its own story. -->
              <span v-if="step.ms !== undefined" class="shrink-0 text-xs tabular-nums text-dimmed">
                {{ step.ms }}ms
              </span>

              <span
                v-if="step.offset"
                class="shrink-0 text-xs tabular-nums text-dimmed"
                :title="step.title"
              >{{ step.offset }}</span>
            </li>

            <!-- Where the trail leads. Without it the last crumb is just
                 another row, and the section's whole claim is that these
                 things ran into something. -->
            <li class="relative flex items-center gap-3 py-1 ps-1 text-sm">
              <span class="grid size-[1.375rem] shrink-0 place-items-center rounded-full bg-error/15">
                <UIcon name="i-lucide-zap" class="size-3 text-error" />
              </span>
              <span class="font-medium text-error">{{ detail.issue.type }}</span>
              <span class="min-w-0 truncate font-mono text-xs text-muted">{{ detail.issue.message }}</span>
            </li>
          </ol>
        </section>
      </template>

      <!-- Two answers to "is this still happening, and to whom" side by side on
           a wide screen, and both below the trace.

           This is the aggregate half of the page, and it belongs after the
           evidence rather than before it. Somebody opens an issue to read the
           stack, the payload it broke on and the headers it arrived with;
           a chart and a facet table above those push the whole reason for the
           visit below the fold, so every arrival began with a scroll past two
           cards nobody came for. Frequency and distribution are what you read
           *second* — once you know what broke, to decide whether it matters. -->
      <!-- Both cards to one fixed height, and each fills it.
           Left to size themselves they took the height of whichever had more
           in it — a facet list of five rows stretched the pair, and the chart
           beside it drew a 128px plot inside a 250px card with the rest left
           blank. A fixed height makes the row predictable whatever the data
           does, and each card then decides what to do with the space: the
           chart grows into it, the list scrolls inside it. -->
      <div class="grid gap-4 lg:grid-cols-2">
        <!-- When it happened, not just how often. A count says an issue is
             frequent; the shape says whether it is over, steady, or starting. -->
        <section
          v-if="trend && trend.points.length > 1"
          class="flex h-[250px] flex-col rounded-lg border border-default p-3"
        >
          <h2 class="mb-2 shrink-0 text-xs font-medium uppercase tracking-wide text-dimmed">
            Occurrences over time
          </h2>

          <TimeChart
            :at="trend.points.map(point => point.at)"
            :series="trendSeries"
            :markers="markers"
            class="min-h-0 flex-1"
            height="h-full"
          />

          <!-- Under the chart and centred, where a legend belongs: it explains
               marks on the plot, so it reads after them. Sharing the heading's
               line it was a second row of text competing with the title for the
               same edge, and on a narrow card it wrapped and pushed the plot
               down. -->
          <div class="mt-2 flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-dimmed">
            <!-- The flat stretch on the left is not a quiet period — the issue
                 did not exist yet. Said out loud, because an unlabelled run of
                 zeroes reads as "it stopped happening", which is the opposite
                 of what it means at the start of a chart. -->
            <span v-if="leadIn" class="flex items-center gap-1.5" :title="leadIn.title">
              <UIcon name="i-lucide-corner-left-down" class="size-3" />from {{ leadIn.release }}
            </span>
            <span v-if="deploys.length" class="flex items-center gap-1.5">
              <span class="h-2 w-px bg-dimmed" />deploys
            </span>
            <!-- What the glyphs on the axis mean. A tick and a loop are compact
                 enough to sit on a crowded chart, which is why they are used —
                 but neither is self-explanatory, and a legend is cheaper than
                 widening every marker back into a word. -->
            <span v-if="markers.some(marker => marker.tone === 'success')" class="flex items-center gap-1 text-success">
              ✓ resolved
            </span>
            <span v-if="markers.some(marker => marker.tone === 'warning')" class="flex items-center gap-1 text-warning">
              ↺ came back
            </span>
            <!-- Said rather than left to be inferred: the chart is drawn from
                 the occurrences that survived trimming, and without this the
                 issue looks as though it began when the oldest kept one did. -->
            <span v-if="trendPartial">
              last {{ formatCount(trend.stored) }} of {{ formatCount(detail.issue.count) }}
            </span>
          </div>
        </section>

        <!-- The evidence behind the sentence above, and the control that
             narrows the occurrences below. A tab per dimension rather than
             five stacked lists: as a column it ran to forty rows. -->
        <section class="flex h-[250px] flex-col overflow-hidden rounded-lg border border-default p-3">
          <h2 class="mb-2 shrink-0 text-xs font-medium uppercase tracking-wide text-dimmed">
            Narrow by
          </h2>

          <IssueBreakdown
            v-model:filter="filter"
            panel-only
            :facets="detail.facets"
            :baseline="baseline"
            :session-count="detail.sessionCount"
            :event-count="detail.eventCount"
            :loading="loading"
            class="min-h-0 flex-1"
            @expand="expandFacets"
          />
        </section>
      </div>
    </template>
  </div>
</template>
