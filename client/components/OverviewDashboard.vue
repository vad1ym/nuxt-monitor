<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  MonitorDashboard,
  MonitorDashboardBreakdown,
  MonitorFacetFilter,
  MonitorFacetName,
  MonitorUptimeSummary,
} from '../../lib/types'
import { api } from '../api'
import { formatCount, formatRate, formatShare } from '../chart'
import { relativeTime } from '../format'
import DonutChart from './DonutChart.vue'
import StatBar from './StatBar.vue'
import TimeChart from './TimeChart.vue'

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

const hasTraffic = computed(() => (totals.value?.requests ?? 0) > 0)

/** Whether anything is drawn at all — an empty window needs one message, not eight. */
const hasAnything = computed(() =>
  Boolean(totals.value && (totals.value.events > 0 || totals.value.requests > 0)),
)

const shown = computed(() =>
  (data.value?.breakdowns ?? []).filter(breakdown => breakdown.slices.length > 0),
)

/** A dimension worth a ring rather than a list: few values, and a composition. */
function isDonut(breakdown: MonitorDashboardBreakdown): boolean {
  return breakdown.slices.length <= 4
    && (breakdown.facet === 'kind' || breakdown.facet === 'deviceType')
}

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

async function load(): Promise<void> {
  loading.value = true
  error.value = ''

  try {
    const [dashboard, bar] = await Promise.all([
      api.dashboard(props.hours, filter.value, chosen.value),
      // Not windowed, so it is fetched once and kept while the window moves.
      uptime.value ? Promise.resolve(uptime.value) : api.uptime(),
    ])

    data.value = dashboard
    uptime.value = bar
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
          <p class="mt-1 text-2xl font-semibold tabular-nums text-highlighted">
            {{ formatCount(totals!.requests) }}
          </p>
          <p class="text-xs text-dimmed">
            {{ active.length ? 'not filtered' : `${formatCount(totals!.failed)} answered 5xx` }}
          </p>
        </div>

        <div class="rounded-lg border border-default p-3">
          <p class="flex items-center gap-1.5 text-xs text-dimmed">
            <UIcon name="i-lucide-percent" class="size-3.5" />Failure rate
          </p>
          <p
            class="mt-1 text-2xl font-semibold tabular-nums"
            :class="(totals!.errorRate ?? 0) > 0.05 ? 'text-error' : 'text-highlighted'"
          >
            {{ formatRate(totals!.errorRate) }}
          </p>
          <p class="text-xs text-dimmed">
            {{ active.length ? 'not filtered' : hasTraffic ? 'of requests served' : 'nothing counted' }}
          </p>
        </div>

        <div class="rounded-lg border border-default p-3">
          <p class="flex items-center gap-1.5 text-xs text-dimmed">
            <UIcon name="i-lucide-bug" class="size-3.5" />Errors
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums text-highlighted">
            {{ formatCount(totals!.events) }}
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
            class="mt-1 text-2xl font-semibold tabular-nums"
            :class="totals!.newIssues ? 'text-warning' : 'text-highlighted'"
          >
            {{ formatCount(totals!.newIssues) }}
          </p>
          <p class="text-xs text-dimmed">
            {{ formatCount(totals!.affectedSessions) }} sessions affected
          </p>
        </div>
      </div>

      <!-- Requests and errors on one axis. Errors rising with traffic is a busy
           afternoon; errors rising against flat traffic is a deploy — and two
           charts side by side make the reader do that comparison by eye. -->
      <section class="rounded-lg border border-default p-3">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Requests and errors
          </h2>
          <div class="flex items-center gap-3 text-xs text-dimmed">
            <span class="flex items-center gap-1.5"><span class="size-2 rounded-sm bg-muted" />requests</span>
            <span class="flex items-center gap-1.5"><span class="size-2 rounded-sm bg-error" />errors</span>
          </div>
        </div>

        <TimeChart :at="trend.at" :series="trend.series" />
      </section>

      <div class="grid gap-3 lg:grid-cols-3">
        <!-- Rings for compositions with a handful of parts, lists for
             everything else: a ring answers "even or lopsided", a bar list
             answers "which is biggest", and they are different questions. -->
        <section
          v-for="breakdown in shown"
          :key="breakdown.facet"
          class="rounded-lg border border-default p-3"
          :class="isDonut(breakdown) ? '' : 'lg:col-span-2'"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <h2 class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-dimmed">
              <UIcon :name="iconFor(breakdown.facet)" class="size-3.5" />
              {{ labelFor(breakdown.facet) }}
            </h2>
            <span v-if="breakdown.otherErrors" class="text-xs text-dimmed">
              +{{ formatCount(breakdown.otherErrors) }} more
            </span>
          </div>

          <DonutChart
            v-if="isDonut(breakdown)"
            :slices="breakdown.slices.map(slice => ({ value: slice.value, count: slice.errors }))"
            :total="formatCount(breakdown.slices.reduce((sum, slice) => sum + slice.errors, 0))"
            label="errors"
            @select="value => narrow(breakdown.facet, value)"
          />

          <div v-else class="space-y-0.5">
            <button
              v-for="slice in breakdown.slices"
              :key="slice.value"
              type="button"
              class="block w-full cursor-pointer text-left"
              :title="slice.trafficShare !== undefined
                ? `${formatShare(slice.errorShare)} of errors, ${formatShare(slice.trafficShare)} of traffic`
                : `${formatShare(slice.errorShare)} of errors`"
              @click="narrow(breakdown.facet, slice.value)"
            >
              <StatBar
                :share="slice.errorShare"
                :label="slice.value"
                :value="formatCount(slice.errors)"
                :hint="slice.lift !== undefined && slice.lift >= 1.3 ? `${slice.lift.toFixed(1)}×` : undefined"
                :tone="slice.lift !== undefined && slice.lift >= 2 ? 'warning' : 'neutral'"
                :mono="breakdown.facet === 'route' || breakdown.facet === 'release'"
              />
            </button>

            <p
              v-if="breakdown.slices.every(slice => slice.lift === undefined)"
              class="pt-1 text-xs text-dimmed"
            >
              {{ ['route', 'release', 'kind', 'group'].includes(breakdown.facet)
                ? 'Shares of errors — traffic is not counted by this dimension.'
                : 'Shares of errors only: no page views counted yet.' }}
            </p>
          </div>
        </section>
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
           than by how much happened while it was out. -->
      <section
        v-if="data!.latestRelease"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-default p-3 text-sm"
      >
        <UIcon name="i-lucide-git-commit-horizontal" class="size-4 shrink-0 text-dimmed" />
        <span class="text-toned">
          <strong class="text-highlighted">{{ data!.latestRelease.newIssues }}</strong>
          {{ data!.latestRelease.newIssues === 1 ? 'issue' : 'issues' }} first appeared in
          <span class="font-mono text-primary/90">{{ data!.latestRelease.release }}</span>
        </span>
        <span class="text-xs text-dimmed">
          · {{ formatCount(data!.latestRelease.events) }} events · last seen
          {{ relativeTime(data!.latestRelease.lastSeen) }}
        </span>
      </section>

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
              <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(issue.lastSeen) }}</span>
            </button>
          </li>
        </ul>
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
