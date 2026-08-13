<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MonitorFacetCounts, MonitorFacetName, MonitorHeatCell, MonitorUptimeSummary } from '../../lib/types'
import { api } from '../api'
import { formatCount, formatRate, formatShare } from '../chart'
import StatBar from './StatBar.vue'

/**
 * What is happening to the application, a level above any one issue.
 *
 * A breakdown inside an issue answers "what do these 250 occurrences have in
 * common". This answers the question above it: how have the last months gone,
 * when do failures happen, and which parts of the audience carry more than
 * their share of them.
 *
 * Every share here is measured against counted page views rather than against
 * other errors. That distinction is the whole reason this screen can be
 * trusted: judged against other errors, the busiest browser always wins and
 * the screen confidently reports the shape of the audience as a finding.
 */
const props = defineProps<{ hours: number }>()

const emit = defineEmits<{ browse: [facet: MonitorFacetName, value: string] }>()

const uptime = ref<MonitorUptimeSummary | null>(null)
const facets = ref<MonitorFacetCounts | null>(null)
const baseline = ref<MonitorFacetCounts | null>(null)
const heat = ref<MonitorHeatCell[]>([])
const loading = ref(true)
const error = ref('')

const days = computed(() => {
  const all = uptime.value?.days ?? []
  const first = all.findIndex(day => day.state !== 'unknown')

  // Trimmed to what was measured, plus a week of lead-in. Ninety grey cells
  // and one coloured sliver is what a fresh install looked like otherwise — a
  // bar that reads as broken rather than as new.
  return first <= 0 ? all : all.slice(Math.max(0, first - 7))
})

const measured = computed(() => uptime.value?.measuredDays ?? 0)

const TONE: Record<string, string> = {
  calm: 'bg-success',
  notable: 'bg-warning',
  bad: 'bg-error',
  // Nothing recorded. Grey rather than green: claiming a day was calm because
  // nobody was watching is the one thing this bar must not say.
  unknown: 'bg-elevated',
}

const STATE_LABEL: Record<string, string> = {
  calm: 'Calm',
  notable: 'Worth a look',
  bad: 'Bad day',
  unknown: 'No data',
}

function dayTitle(day: MonitorUptimeSummary['days'][number]): string {
  const date = new Date(day.day).toLocaleDateString(undefined, { dateStyle: 'medium' })
  const parts = [`${date} — ${STATE_LABEL[day.state]}`]

  if (day.newIssues) {
    parts.push(`${day.newIssues} new ${day.newIssues === 1 ? 'issue' : 'issues'}`)
  }

  if (day.watchedIssues) {
    parts.push(`${day.watchedIssues} in a watched group`)
  }

  if (day.requests) {
    parts.push(`${formatCount(day.requests)} requests`, `${formatRate(day.rate)} failed`)
  }

  return parts.join(' · ')
}

/**
 * The dimensions worth a column, in the order a finding narrows the search.
 *
 * Route and release are left out: both are on other screens already, and both
 * are usually a restatement of where the code lives rather than a property of
 * whoever hit it.
 */
const DIMENSIONS: { facet: MonitorFacetName, title: string }[] = [
  { facet: 'browser', title: 'Browser' },
  { facet: 'os', title: 'OS' },
  { facet: 'deviceType', title: 'Device' },
]

/**
 * A dimension's values with their over-representation against the audience.
 *
 * `lift` is the number that matters and the reason the traffic baseline
 * exists: 60% of errors on a browser that is 60% of traffic is nothing, and
 * 60% on a browser that is 6% is the answer.
 */
const breakdowns = computed(() => DIMENSIONS.map(({ facet, title }) => {
  const values = facets.value?.[facet]?.values ?? []
  const audience = baseline.value?.[facet]?.values ?? []
  const total = values.reduce((sum, value) => sum + value.count, 0)

  return {
    facet,
    title,
    rows: values.slice(0, 6).map((value) => {
      const share = audience.find(row => row.value === value.value)?.share

      return {
        ...value,
        // Undefined rather than a number when the audience never showed this
        // value: an absent baseline is not a lift of zero, and drawing it as
        // one would rank a real skew below a measured tie.
        lift: share ? value.share / share : undefined,
        audienceShare: share,
      }
    }),
    total,
  }
}))

/** The busiest cell, so every other is drawn relative to it. */
const peak = computed(() => Math.max(1, ...heat.value.map(cell => cell.count)))

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const grid = computed(() => {
  const cells = new Map(heat.value.map(cell => [`${cell.day}:${cell.hour}`, cell.count]))

  return WEEKDAYS.map((label, day) => ({
    label,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: cells.get(`${day}:${hour}`) ?? 0,
    })),
  }))
})

const hasHeat = computed(() => heat.value.some(cell => cell.count > 0))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''

  try {
    const [bar, sections] = await Promise.all([
      api.uptime(),
      api.stats('environments', props.hours),
    ])

    uptime.value = bar
    facets.value = sections.environments ?? null
    baseline.value = sections.traffic_facets ?? null

    // Its own call: the heat map reads every event in the window, which is the
    // one query here worth not making while somebody is only after the bar.
    heat.value = (await api.stats('heatmap', props.hours)).heatmap ?? []
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not load statistics'
  }
  finally {
    loading.value = false
  }
}

watch(() => props.hours, load)
onMounted(load)
</script>

<template>
  <div class="space-y-5">
    <header>
      <h1 class="text-lg font-semibold text-highlighted">
        Statistics
      </h1>
      <p class="text-sm text-dimmed">
        How the application has been doing, above the level of any one issue. Shares are
        measured against counted page views, not against other errors.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      icon="i-lucide-triangle-alert"
    />

    <div v-else-if="loading && !uptime" class="space-y-3">
      <USkeleton class="h-24 w-full" />
      <USkeleton class="h-40 w-full" />
    </div>

    <template v-else>
      <!-- Ninety days at a glance. Deliberately not windowed with the rest of
           the screen: "has this been calm" is a question about months. -->
      <section class="rounded-lg border border-default p-4">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Days
          </h2>

          <p v-if="measured" class="text-sm text-dimmed">
            <span class="tabular-nums text-toned">{{ uptime!.calmDays }}</span>
            of the last
            <span class="tabular-nums text-toned">{{ measured }}</span>
            recorded {{ measured === 1 ? 'day was' : 'days were' }} calm
          </p>
        </div>

        <div v-if="!measured" class="py-6 text-center text-sm text-muted">
          Nothing recorded yet.
        </div>

        <template v-else>
          <div class="flex items-stretch gap-px overflow-hidden rounded">
            <span
              v-for="day in days"
              :key="day.day"
              class="h-8 min-w-0 flex-1 rounded-[1px] transition-opacity hover:opacity-70"
              :class="TONE[day.state]"
              :title="dayTitle(day)"
            />
          </div>

          <div class="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-dimmed">
            <span>{{ days.length === 1 ? 'today' : `${days.length} days ago` }}</span>
            <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span v-for="state in ['calm', 'notable', 'bad', 'unknown']" :key="state" class="flex items-center gap-1.5">
                <span class="size-2 rounded-sm" :class="TONE[state]" />{{ STATE_LABEL[state] }}
              </span>
            </span>
            <span>today</span>
          </div>
        </template>
      </section>

      <!-- When, rather than how many. A fault confined to the nightly batch is
           a flat line on a chart and an obvious bright row here. -->
      <section v-if="hasHeat" class="rounded-lg border border-default p-4">
        <h2 class="mb-3 text-xs font-medium uppercase tracking-wide text-dimmed">
          When errors happen
        </h2>

        <div class="space-y-1">
          <div v-for="row in grid" :key="row.label" class="flex items-center gap-2">
            <span class="w-8 shrink-0 text-xs text-dimmed">{{ row.label }}</span>
            <div class="flex flex-1 gap-px">
              <span
                v-for="cell in row.hours"
                :key="cell.hour"
                class="h-4 min-w-0 flex-1 rounded-[1px]"
                :class="cell.count ? 'bg-primary' : 'bg-elevated/50'"
                :style="cell.count ? { opacity: 0.25 + 0.75 * (cell.count / peak) } : undefined"
                :title="`${row.label} ${String(cell.hour).padStart(2, '0')}:00 — ${cell.count} ${cell.count === 1 ? 'error' : 'errors'}`"
              />
            </div>
          </div>
        </div>

        <div class="mt-2 flex justify-between ps-10 text-xs text-dimmed">
          <span>00:00</span><span>12:00</span><span>23:00</span>
        </div>
      </section>

      <!-- Who is affected, judged against who was there. -->
      <div class="grid gap-3 md:grid-cols-3">
        <section
          v-for="breakdown in breakdowns"
          :key="breakdown.facet"
          class="rounded-lg border border-default p-3"
        >
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
            {{ breakdown.title }}
          </h2>

          <p v-if="!breakdown.rows.length" class="py-4 text-center text-xs text-dimmed">
            Nothing recorded.
          </p>

          <div v-else class="space-y-0.5">
            <button
              v-for="row in breakdown.rows"
              :key="row.value"
              type="button"
              class="block w-full cursor-pointer text-left"
              :title="row.audienceShare !== undefined
                ? `${formatShare(row.share)} of errors, ${formatShare(row.audienceShare)} of traffic`
                : `${formatShare(row.share)} of errors`"
              @click="emit('browse', breakdown.facet, row.value)"
            >
              <StatBar
                :share="row.share"
                :label="row.value"
                :value="formatCount(row.count)"
                :hint="row.lift !== undefined && row.lift >= 1.3 ? `${row.lift.toFixed(1)}×` : undefined"
                :tone="row.lift !== undefined && row.lift >= 2 ? 'warning' : 'neutral'"
              />
            </button>
          </div>

          <p v-if="!baseline" class="mt-2 text-xs text-dimmed">
            No page views counted yet, so these are shares of errors only.
          </p>
        </section>
      </div>
    </template>
  </div>
</template>
