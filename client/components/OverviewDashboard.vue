<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  MonitorDashboard,
  MonitorFacetFilter,
  MonitorFacetName,
  MonitorHeatCell,
  MonitorUptimeSummary,
} from '../../lib/types'
import { api } from '../api'
import { formatCount, formatRate, formatShare } from '../chart'
import { relativeTime } from '../format'
import DeltaBadge from './DeltaBadge.vue'
import HeatMap from './HeatMap.vue'
import StatBar from './StatBar.vue'
import TimeChart from './LazyTimeChart'

/**
 * Traffic and errors, on one screen, always together.
 *
 * The rule this is built on: **no count appears without its denominator**.
 * Four hundred errors is a catastrophe on a quiet internal tool and a rounding
 * error on a busy shop, and a breakdown ranked by error count alone ends up
 * ranking browsers by popularity — the reader knew that already and did not
 * ask.
 *
 * So the shape is fixed: the health of the window, then traffic and errors on
 * one axis, then who and what is over-represented. Everything else — more
 * dimensions, a longer tail — is a filter away rather than on screen by
 * default, because a screen that shows everything shows nothing.
 */
const props = defineProps<{ hours: number }>()

const emit = defineEmits<{
  browse: [facet: MonitorFacetName, value: string]
  /** Open one issue. The screen names what is worth opening; the list is elsewhere. */
  select: [fingerprint: string]
}>()

const data = ref<MonitorDashboard | null>(null)
const uptime = ref<MonitorUptimeSummary | null>(null)
const heat = ref<MonitorHeatCell[] | null>(null)
const loading = ref(true)
const error = ref('')

/** Narrows every number on the screen at once. */
const filter = ref<MonitorFacetFilter>({})

/**
 * Dimensions on screen.
 *
 * The first four are what earns its place without being asked for: what kind
 * of thing failed, on what, and for whom. The rest are opt-in — a dimension
 * that is empty for most applications is clutter until somebody wants it.
 */
const DIMENSIONS: { facet: MonitorFacetName, label: string, icon: string }[] = [
  { facet: 'kind', label: 'Kind', icon: 'i-lucide-shapes' },
  { facet: 'browser', label: 'Browser', icon: 'i-lucide-globe' },
  { facet: 'os', label: 'OS', icon: 'i-lucide-monitor' },
  { facet: 'deviceType', label: 'Device', icon: 'i-lucide-smartphone' },
  { facet: 'group', label: 'Group', icon: 'i-lucide-tag' },
  { facet: 'release', label: 'Release', icon: 'i-lucide-git-commit-horizontal' },
  { facet: 'browserVersion', label: 'Browser version', icon: 'i-lucide-git-branch' },
  { facet: 'osVersion', label: 'OS version', icon: 'i-lucide-layers' },
  { facet: 'route', label: 'Route', icon: 'i-lucide-route' },
]

const DEFAULT_FACETS: MonitorFacetName[] = ['kind', 'browser', 'os', 'deviceType']

const chosen = ref<MonitorFacetName[]>([...DEFAULT_FACETS])

const totals = computed(() => data.value?.totals)

/** The calm-days bar, kept: it is the one figure not bounded by the window. */
const days = computed(() => {
  const all = uptime.value?.days ?? []
  const first = all.findIndex(day => day.state !== 'unknown')

  return first <= 0 ? all : all.slice(Math.max(0, first - 7))
})

/**
 * The zone the heatmap is drawn in, named for the reader.
 *
 * Read once rather than computed per render — it cannot change while the page
 * is open, and `resolvedOptions()` is not free. Falls back to a plain word
 * where the API is unavailable, since a heading is not worth an exception.
 */
const localZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your timezone'
  }
  catch {
    return 'your timezone'
  }
})()

const DAY_TONE: Record<string, string> = {
  calm: 'bg-success',
  notable: 'bg-warning',
  bad: 'bg-error',
  unknown: 'bg-elevated',
}

const trend = computed(() => {
  const points = data.value?.trend ?? []

  return {
    at: points.map(point => point.bucket),
    series: [
      // Requests first, so errors are read against the volume that produced
      // them rather than on their own.
      { name: 'requests', values: points.map(point => point.requests), color: 'var(--ui-text-dimmed)' },
      { name: 'errors', values: points.map(point => point.errors), color: 'var(--ui-error)' },
    ],
  }
})

/**
 * Deploys, as lines on the chart above.
 *
 * The title carries what the line cannot: how many issues that release was the
 * first to show. A marker saying only "1.8.2" tells you a deploy happened;
 * hovering says whether it brought anything with it.
 *
 * Empty whenever `release` is not configured, and that is the right outcome —
 * without it the module was never told when anything shipped, and a line at
 * the moment collection started would be a deploy marker for something that
 * was not a deploy.
 */
const deploys = computed(() =>
  (data.value?.deploys ?? []).map(deploy => ({
    at: deploy.at,
    label: deploy.release,
    newIssues: deploy.newIssues,
    title: deploy.newIssues
      ? `${deploy.release} — first seen here: ${deploy.newIssues} new ${deploy.newIssues === 1 ? 'issue' : 'issues'}`
      : `${deploy.release} — nothing new appeared`,
  })),
)

/**
 * The deploys in this window other than the one the banner already names.
 *
 * Newest first, and the latest release is dropped because the sentence above
 * is about exactly that one — repeating it would read as two deploys.
 */
const earlierDeploys = computed(() => {
  const latest = data.value?.latestRelease?.release

  return deploys.value
    .filter(deploy => deploy.label !== latest)
    .map(deploy => ({ release: deploy.label, newIssues: deploy.newIssues }))
    .reverse()
})

const hasTraffic = computed(() => (totals.value?.requests ?? 0) > 0)

/** Whether anything is drawn at all — an empty window needs one message, not eight. */
const hasAnything = computed(() =>
  Boolean(totals.value && (totals.value.events > 0 || totals.value.requests > 0)),
)

/** Which dimension the table is showing. */
const tab = ref<MonitorFacetName>('browser')

const shown = computed(() =>
  (data.value?.breakdowns ?? [])
    .map(breakdown => ({
      ...breakdown,
      // `unknown` means the event carried no such dimension — a server error
      // has no browser. It is a real answer and never an actionable one, and
      // leaving it in the rows lets it outrank every slice somebody could do
      // something about. The count is not lost: it goes to the tail.
      slices: (() => {
        const real = breakdown.slices.filter(slice => slice.value !== 'unknown')
        const total = real.reduce((sum, slice) => sum + slice.errors, 0)

        // Re-based on what is drawn. Left as shares of the whole, the widest
        // bar would sit at a third of the row and the column would read as
        // three-quarters empty — the chart understating its own data.
        return real.map(slice => ({
          ...slice,
          errorShare: total ? slice.errors / total : 0,
        }))
      })(),
      otherErrors: breakdown.otherErrors
        + breakdown.slices.filter(slice => slice.value === 'unknown')
          .reduce((sum, slice) => sum + slice.errors, 0),
    }))
    .filter(breakdown => breakdown.slices.length > 0),
)

/**
 * The breakdown on screen.
 *
 * Falls back to the first available rather than showing nothing: the chosen
 * dimension can vanish when a filter empties it, and an empty block below a
 * row of tabs reads as broken.
 */
const current = computed(() =>
  shown.value.find(breakdown => breakdown.facet === tab.value) ?? shown.value[0],
)

function labelFor(facet: MonitorFacetName): string {
  return DIMENSIONS.find(entry => entry.facet === facet)?.label ?? facet
}

function iconFor(facet: MonitorFacetName): string {
  return DIMENSIONS.find(entry => entry.facet === facet)?.icon ?? 'i-lucide-tag'
}

function toggle(facet: MonitorFacetName): void {
  chosen.value = chosen.value.includes(facet)
    ? chosen.value.filter(entry => entry !== facet)
    : [...chosen.value, facet]
}

/** Clicking a slice narrows the screen rather than leaving it. */
function narrow(facet: MonitorFacetName, value: string): void {
  if (value === 'unknown') {
    return
  }

  filter.value = { ...filter.value, [facet]: [value] }
}

function clearFilter(facet: MonitorFacetName): void {
  const next = { ...filter.value }

  delete next[facet]
  filter.value = next
}

const active = computed(() =>
  Object.entries(filter.value).flatMap(([facet, values]) =>
    (values ?? []).map(value => ({ facet: facet as MonitorFacetName, value })),
  ),
)

/**
 * The window before this one, for the direction badges.
 *
 * Withheld entirely while a filter is on. The request counters carry no
 * browser or group, so the two traffic tiles are never narrowed — they already
 * say "not filtered" — and a delta on them would compare a filtered present
 * against an unfiltered past. The error tiles *are* filtered and could show
 * one honestly, but a row where two badges mean one thing and two mean another
 * is worse than no badges: nothing on screen says which is which, and a
 * comparison needing a footnote is not doing its job.
 */
const previous = computed(() => active.value.length ? undefined : data.value?.previous)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''

  try {
    const [dashboard, bar, stats] = await Promise.all([
      api.dashboard(props.hours, filter.value, chosen.value),
      // Not windowed, so it is fetched once and kept while the window moves.
      uptime.value ? Promise.resolve(uptime.value) : api.uptime(),
      // Windowed, unlike the bar above: "when do errors happen" is a question
      // about the period being looked at, and a week of history under a
      // one-hour heading would be a second scale on the same screen.
      api.stats('heatmap', props.hours),
    ])

    data.value = dashboard
    uptime.value = bar
    heat.value = stats.heatmap ?? []
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not load the dashboard'
  }
  finally {
    loading.value = false
  }
}

watch(() => props.hours, load)
watch([filter, chosen], load, { deep: true })
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold text-highlighted">
          Overview
        </h1>
        <p class="text-sm text-dimmed">
          What the application served, and what failed doing it. Every share is measured
          against counted page views, never against other errors.
        </p>
      </div>

      <!-- Dimensions are added and removed here rather than shipped all at
           once: a screen that shows everything shows nothing. -->
      <UDropdownMenu
        :items="[DIMENSIONS.map(entry => ({
          label: entry.label,
          icon: entry.icon,
          type: 'checkbox' as const,
          checked: chosen.includes(entry.facet),
          onUpdateChecked: () => toggle(entry.facet),
        }))]"
        :content="{ align: 'end' }"
      >
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-sliders-horizontal"
          :label="`${chosen.length} breakdowns`"
          trailing-icon="i-lucide-chevron-down"
        />
      </UDropdownMenu>
    </header>

    <!-- What the screen is currently narrowed to, and the way back out. -->
    <div v-if="active.length" class="flex flex-wrap items-center gap-1.5">
      <UBadge
        v-for="entry in active"
        :key="`${entry.facet}:${entry.value}`"
        color="primary"
        variant="subtle"
        size="sm"
        class="cursor-pointer"
        :label="`${labelFor(entry.facet)}: ${entry.value}`"
        trailing-icon="i-lucide-x"
        @click="clearFilter(entry.facet)"
      />
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        label="Clear all"
        @click="filter = {}"
      />
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      icon="i-lucide-triangle-alert"
    />

    <div v-else-if="loading && !data" class="space-y-3">
      <USkeleton class="h-20 w-full" />
      <USkeleton class="h-44 w-full" />
      <USkeleton class="h-40 w-full" />
    </div>

    <div v-else-if="!hasAnything" class="rounded-lg border border-dashed border-default py-16 text-center">
      <UIcon name="i-lucide-chart-line" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        Nothing recorded in this window.
      </p>
      <p class="mt-1 text-xs text-dimmed">
        {{ active.length ? 'Try clearing the filters, or widen the window.' : 'Widen the window, or wait for traffic.' }}
      </p>
    </div>

    <template v-else>
      <!-- The four numbers worth reading before anything else. Requests first:
           it is the denominator every other figure here is against.

           The two traffic figures are marked "not filtered" while a filter is
           on, and are deliberately not narrowed: request counters are
           aggregates with no browser or group attached, so there is nothing to
           narrow them by. Quietly leaving them looking filtered would be the
           screen contradicting itself. -->
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-lg border border-default p-3">
          <p class="flex items-center gap-1.5 text-xs text-dimmed">
            <UIcon name="i-lucide-arrow-down-up" class="size-3.5" />Requests
          </p>
          <p class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums text-highlighted">
            {{ formatCount(totals!.requests) }}
            <!-- Traffic rising is not a fault, so this one is never red. -->
            <DeltaBadge
              :current="totals!.requests"
              :previous="previous?.requests"
              :format="formatCount"
            />
          </p>
          <p class="text-xs text-dimmed">
            <!-- "failed", not "answered 5xx": the rate counts the 4xx range
                 too, since a backend answering 422 to its own frontend is a
                 fault. Naming one class here would describe a smaller number
                 than the one shown. -->
            {{ active.length ? 'not filtered' : `${formatCount(totals!.failed)} failed` }}
          </p>
        </div>

        <div class="rounded-lg border border-default p-3">
          <p class="flex items-center gap-1.5 text-xs text-dimmed">
            <UIcon name="i-lucide-percent" class="size-3.5" />Failure rate
          </p>
          <p
            class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums"
            :class="(totals!.errorRate ?? 0) > 0.05 ? 'text-error' : 'text-highlighted'"
          >
            {{ formatRate(totals!.errorRate) }}
            <!-- Compared in percentage points, not as a ratio of ratios: a
                 rate going 1% → 2% is "+1 point", and calling it "+100%"
                 would be true and unreadable. Scaled by 100 so the badge's
                 own floor is applied to points rather than to fractions. -->
            <DeltaBadge
              v-if="totals!.errorRate !== undefined"
              :current="totals!.errorRate * 100"
              :previous="previous && previous.errorRate !== undefined ? previous.errorRate * 100 : undefined"
              up-is-bad
              :format="value => formatRate(value / 100)"
            />
          </p>
          <p class="text-xs text-dimmed">
            {{ active.length ? 'not filtered' : hasTraffic ? 'of requests served' : 'nothing counted' }}
          </p>
        </div>

        <div class="rounded-lg border border-default p-3">
          <p class="flex items-center gap-1.5 text-xs text-dimmed">
            <UIcon name="i-lucide-bug" class="size-3.5" />Errors
          </p>
          <p class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums text-highlighted">
            {{ formatCount(totals!.events) }}
            <DeltaBadge
              :current="totals!.events"
              :previous="previous?.events"
              up-is-bad
              :format="formatCount"
            />
          </p>
          <p class="text-xs text-dimmed">
            across {{ formatCount(totals!.issues) }} {{ totals!.issues === 1 ? 'issue' : 'issues' }}
          </p>
        </div>

        <div class="rounded-lg border border-default p-3">
          <p class="flex items-center gap-1.5 text-xs text-dimmed">
            <UIcon name="i-lucide-sparkle" class="size-3.5" />New issues
          </p>
          <p
            class="mt-1 flex items-baseline gap-2 text-2xl font-semibold tabular-nums"
            :class="totals!.newIssues ? 'text-warning' : 'text-highlighted'"
          >
            {{ formatCount(totals!.newIssues) }}
            <DeltaBadge
              :current="totals!.newIssues"
              :previous="previous?.newIssues"
              up-is-bad
              :format="formatCount"
            />
          </p>
          <p class="text-xs text-dimmed">
            {{ formatCount(totals!.affectedSessions) }} sessions affected
          </p>
        </div>
      </div>

      <!-- The one fault behind most of the noise. In most incidents there is
           one, and finding it by scrolling a list ranked by count is work the
           screen can do instead. -->
      <section
        v-if="data!.topIssue"
        class="rounded-lg border border-warning/40 bg-warning/5 p-3"
      >
        <h2 class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-dimmed">
          <UIcon name="i-lucide-flame" class="size-3.5" />Biggest contributor
        </h2>

        <button
          type="button"
          class="mt-2 w-full cursor-pointer text-left"
          @click="emit('select', data!.topIssue.issue.fingerprint)"
        >
          <p class="text-sm text-highlighted">
            {{ data!.topIssue.issue.message }}
          </p>
          <p class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-dimmed">
            <span class="font-medium text-muted">{{ data!.topIssue.issue.type }}</span>
            <span v-if="data!.topIssue.issue.culprit" class="font-mono text-primary/90">
              {{ data!.topIssue.issue.culprit }}
            </span>
            <span>
              {{ data!.topIssue.issue.count }} events,
              <strong class="text-muted">{{ formatRate(data!.topIssue.share) }}</strong> of all errors
            </span>
          </p>
        </button>
      </section>

      <!-- Whether the last deploy brought anything with it — a first-screen
           question, answered by what *first appeared* in that release rather
           than by how much happened while it was out.

           "release" is said out loud. The value is a version or a commit sha,
           but it is also whatever `NUXT_MONITOR_RELEASE` happens to hold — on
           a dev machine, the word `dev`. "first appeared in dev" then reads as
           an environment, and the sentence appears to be about staging versus
           production rather than about a deploy. Naming the noun costs three
           words and removes the only reading that is wrong. -->
      <section
        v-if="data!.latestRelease"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-default p-3 text-sm"
      >
        <UIcon name="i-lucide-git-commit-horizontal" class="size-4 shrink-0 text-dimmed" />
        <span class="text-toned">
          <strong class="text-highlighted">{{ data!.latestRelease.newIssues }}</strong>
          {{ data!.latestRelease.newIssues === 1 ? 'issue' : 'issues' }} first appeared in release
          <span class="font-mono text-primary/90">{{ data!.latestRelease.release }}</span>
        </span>
        <!-- Both figures are for the selected window, like the tiles above.
             They used to be lifetime totals sitting inches from hourly ones,
             with nothing on screen to say the two were measured differently. -->
        <span class="text-xs text-dimmed">
          · {{ formatCount(data!.latestRelease.events) }} events in this window · last seen
          {{ relativeTime(data!.latestRelease.lastSeen) }}
        </span>

        <!-- The other releases that started inside this window, each with what
             it introduced. On the line rather than behind a hover on the
             chart: a one-pixel dashed line is a poor thing to ask somebody to
             find with a mouse, and this is the sentence they came for. -->
        <span v-if="earlierDeploys.length" class="w-full text-xs text-dimmed">
          Also in this window:
          <template v-for="(deploy, index) in earlierDeploys" :key="deploy.release">
            <span v-if="index">, </span><span class="font-mono">{{ deploy.release }}</span>
            <span>{{ deploy.newIssues ? ` (${deploy.newIssues} new)` : ' (nothing new)' }}</span>
          </template>
        </span>
      </section>

      <!-- Requests and errors on one axis. Errors rising with traffic is a busy
           afternoon; errors rising against flat traffic is a deploy — and two
           charts side by side make the reader do that comparison by eye.

           The deploys are drawn on the same axis for the same reason: "it
           started after the release" is a statement about what the line does
           either side of a moment, and no list of deploy times beside the
           chart lets anybody see that. -->
      <section class="rounded-lg border border-default p-3">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Requests and errors
          </h2>
          <div class="flex items-center gap-3 text-xs text-dimmed">
            <span class="flex items-center gap-1.5"><span class="size-2 rounded-sm bg-muted" />requests</span>
            <span class="flex items-center gap-1.5"><span class="size-2 rounded-sm bg-error" />errors</span>
            <span v-if="deploys.length" class="flex items-center gap-1.5">
              <span class="h-2.5 w-px bg-dimmed" />deploys
            </span>
          </div>
        </div>

        <TimeChart :at="trend.at" :series="trend.series" :markers="deploys" />
      </section>

      <!-- Paired: both are short lists about where the load and the
           failures land, and each on its own row stretched a handful of
           rows across the whole screen. -->
      <div class="grid gap-3 xl:grid-cols-2">
        <!-- The endpoints themselves, which have their own denominator and so
             carry a real rate rather than a share. -->
        <section v-if="data!.routes.length" class="rounded-lg border border-default p-3">
          <h2 class="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-dimmed">
            <UIcon name="i-lucide-route" class="size-3.5" />Busiest endpoints
          </h2>

          <div class="space-y-0.5">
            <button
              v-for="route in data!.routes"
              :key="route.route"
              type="button"
              class="block w-full cursor-pointer text-left"
              @click="emit('browse', 'route', route.route)"
            >
              <StatBar
                :share="route.total / Math.max(1, data!.routes[0]!.total)"
                :label="route.route"
                :value="formatCount(route.total)"
                :hint="route.failed ? formatShare(route.rate) : undefined"
                :tone="route.rate >= 0.05 ? 'error' : route.failed ? 'warning' : 'neutral'"
                mono
              />
            </button>
          </div>
        </section>

        <!-- One block with tabs rather than a card per dimension.
             Four cards each showed two rows and stood two-thirds empty, and the
             reader had to compare across them by eye. One table, switched by a
             tab, gives every dimension the full width — enough for the traffic
             it produced, the errors it caused and the rate between them, side by
             side, which is the comparison the screen exists for. -->
        <section class="rounded-lg border border-default p-3">
          <div class="mb-3 flex flex-wrap items-center gap-1">
            <UButton
              v-for="breakdown in shown"
              :key="breakdown.facet"
              size="xs"
              :color="tab === breakdown.facet ? 'primary' : 'neutral'"
              :variant="tab === breakdown.facet ? 'subtle' : 'ghost'"
              :icon="iconFor(breakdown.facet)"
              :label="labelFor(breakdown.facet)"
              @click="tab = breakdown.facet"
            />
          </div>

          <template v-if="current">
            <div>
              <!-- No ring here. In half a column it would take the width the
                   three number columns need, to say what the bars behind the
                   rows already say. -->
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-3 px-2 pb-1 text-[11px] uppercase tracking-wide text-dimmed">
                  <span class="min-w-0 flex-1">{{ labelFor(current.facet) }}</span>
                  <span class="w-16 text-end">Requests</span>
                  <span class="w-16 text-end">Errors</span>
                  <span class="w-20 text-end">Per view</span>
                </div>

                <div class="space-y-0.5">
                  <button
                    v-for="slice in current.slices"
                    :key="slice.value"
                    type="button"
                    class="relative flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded px-2 py-1.5 text-left text-sm hover:bg-elevated/40"
                    @click="narrow(current!.facet, slice.value)"
                  >
                    <!-- Width is the share of errors, colour is whether the rate
                         is unusual: a wide grey row is a big slice behaving
                         normally, a narrow amber one is a small slice that is not. -->
                    <span
                      class="absolute inset-y-0 start-0 -z-10 rounded"
                      :class="slice.lift !== undefined && slice.lift >= 2
                        ? 'bg-warning/20'
                        : 'bg-elevated/60'"
                      :style="{ width: `${Math.max(slice.errorShare * 100, 1.5)}%` }"
                    />

                    <span
                      class="min-w-0 flex-1 truncate text-toned"
                      :class="['route', 'release', 'browserVersion', 'osVersion'].includes(current!.facet) ? 'font-mono' : ''"
                    >{{ slice.value }}</span>

                    <span class="w-16 shrink-0 text-end tabular-nums text-dimmed">
                      {{ slice.traffic ? formatCount(slice.traffic) : '—' }}
                    </span>

                    <span class="w-16 shrink-0 text-end tabular-nums text-highlighted">
                      {{ formatCount(slice.errors) }}
                    </span>

                    <span
                      class="w-20 shrink-0 text-end text-xs tabular-nums"
                      :class="slice.lift !== undefined && slice.lift >= 2 ? 'text-warning' : 'text-dimmed'"
                    >
                      <template v-if="slice.errorsPerView !== undefined">
                        {{ slice.errorsPerView.toFixed(2) }}
                        <span v-if="slice.lift !== undefined && slice.lift >= 1.3" class="text-warning">
                          {{ slice.lift.toFixed(1) }}×
                        </span>
                      </template>
                      <template v-else>—</template>
                    </span>
                  </button>
                </div>

                <p class="mt-2 px-2 text-xs text-dimmed">
                  <template v-if="current.otherErrors">
                    {{ formatCount(current.otherErrors) }} more in values not listed.
                  </template>
                  {{ ['route', 'release', 'kind', 'group'].includes(current.facet)
                    ? 'Traffic is not counted by this dimension, so there is no rate to compare against.'
                    : current.slices.every(slice => slice.errorsPerView === undefined)
                      ? 'Not enough page views counted to give these a rate.'
                      : 'Per view is errors per page view; the multiplier is against the application average.' }}
                </p>
              </div>
            </div>
          </template>
        </section>
      </div>

      <!-- What just happened, for the glance that does not start from a
           number. -->
      <section v-if="data!.recent.length">
        <h2 class="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-dimmed">
          <UIcon name="i-lucide-clock" class="size-3.5" />Most recent
        </h2>

        <ul class="divide-y divide-default border-y border-default">
          <li v-for="issue in data!.recent.slice(0, 5)" :key="issue.fingerprint">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-2.5 px-2 py-2 text-left hover:bg-elevated/40"
              @click="emit('select', issue.fingerprint)"
            >
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="issue.side === 'client' ? 'bg-info' : 'bg-warning'"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-highlighted">{{ issue.message }}</span>
                <span v-if="issue.culprit" class="block truncate font-mono text-xs text-dimmed">
                  {{ issue.culprit }}
                </span>
              </span>
              <!-- Said here too, not only in the issue list. This screen is
                   where somebody decides what to look at first, and a fault
                   that outlived its own fix outranks a new one. -->
              <UBadge
                v-if="issue.regressedAt && !issue.resolved"
                color="warning"
                variant="subtle"
                size="sm"
                icon="i-lucide-rotate-ccw"
                class="shrink-0"
                label="regression"
                title="Marked resolved, then happened again"
              />
              <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(issue.lastSeen) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <!-- When, rather than how much. The trend answers "is it happening now";
           this answers "is it always at 3am" — and a fault confined to the
           nightly batch reads as a low flat line on the first and an obvious
           bright band on the second. -->
      <section v-if="heat?.length" class="rounded-lg border border-default p-3">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-dimmed">
            <UIcon name="i-lucide-clock" class="size-3.5" />Hour of the week
          </h2>
          <!-- Named rather than left implicit. The grid is folded into
               whichever zone the browser is in, so two people reading the same
               data from different places see different — and each correct —
               pictures. Saying which zone is what makes that legible instead
               of confusing when they compare screens. -->
          <p class="text-xs text-dimmed">
            {{ localZone }}
          </p>
        </div>

        <HeatMap :cells="heat" empty-label="No errors in this window." />
      </section>

      <!-- Ninety days, deliberately outside the window: "has this been calm" is
           a question about months, not about the last six hours. -->
      <section v-if="days.length" class="rounded-lg border border-default p-3">
        <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-dimmed">
            <UIcon name="i-lucide-calendar-check" class="size-3.5" />Days
          </h2>
          <p class="text-xs text-dimmed">
            <span class="tabular-nums text-toned">{{ uptime!.calmDays }}</span>
            of the last
            <span class="tabular-nums text-toned">{{ uptime!.measuredDays }}</span>
            recorded {{ uptime!.measuredDays === 1 ? 'day was' : 'days were' }} calm
          </p>
        </div>

        <div class="flex items-stretch gap-px overflow-hidden rounded">
          <span
            v-for="day in days"
            :key="day.day"
            class="h-6 min-w-0 flex-1 rounded-[1px]"
            :class="DAY_TONE[day.state]"
            :title="`${new Date(day.day).toLocaleDateString(undefined, { dateStyle: 'medium' })} — ${day.newIssues} new, ${formatRate(day.rate)} failed`"
          />
        </div>
      </section>
    </template>
  </div>
</template>
