<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { MonitorUptime, MonitorUptimeDay } from '../../lib/types'
import { api } from '../api'
import { formatCount, formatRate } from '../chart'
import { absoluteTime, relativeTime } from '../format'

/**
 * Whether the application has been up.
 *
 * The one screen here that does not answer "what broke". It answers "has this
 * been reliable", which is asked over months rather than hours — so it ignores
 * the dashboard's shared window on purpose.
 *
 * Built on heartbeats as well as errors, and that is the whole reason it can be
 * trusted: a process that is down produces no errors at all, so a bar drawn
 * from the error table alone would paint the worst possible outage green.
 */

const data = ref<MonitorUptime | null>(null)
const loading = ref(true)
const error = ref('')

const all = computed(() => data.value?.days ?? [])

/**
 * The days actually drawn.
 *
 * Trimmed to what was measured, plus a little context. Ninety grey cells and
 * one coloured sliver is what a fresh install looked like otherwise — a bar
 * that reads as broken rather than as new, and that hides the one day there is
 * something to say about.
 */
const days = computed(() => {
  const first = all.value.findIndex(day => day.state !== 'unknown')

  if (first <= 0) {
    return all.value
  }

  // A week of lead-in, so the bar still reads as a timeline rather than as a
  // single cell floating on its own.
  return all.value.slice(Math.max(0, first - 7))
})

/** Days that were actually observed — the rest are before collection started. */
const observed = computed(() => all.value.filter(day => day.state !== 'unknown'))

const incidents = computed(() => data.value?.incidents ?? [])

/**
 * The headline, in words.
 *
 * A percentage alone does not say what is true *now*, which is the first thing
 * anybody wants from a status bar.
 */
const current = computed(() => {
  const latest = observed.value.at(-1)

  if (!latest) {
    return { label: 'Not measured yet', tone: 'neutral' as const }
  }

  // An incident that has not closed yet: the last beat is older than the
  // tolerance, so as far as this process knows it is not running.
  const ongoing = incidents.value[0]

  if (ongoing && Date.now() - ongoing.to < 5 * 60_000) {
    return { label: 'Not responding', tone: 'error' as const }
  }

  // Today's verdict, not just this minute's. A gap earlier today is still the
  // most important thing on the screen — saying "Operational" above a red cell
  // and a 25-minute incident is the screen contradicting itself.
  if (latest.state === 'down') {
    return { label: 'Recovered', tone: 'warning' as const }
  }

  if (latest.state === 'degraded') {
    return { label: 'Degraded', tone: 'warning' as const }
  }

  return { label: 'Operational', tone: 'success' as const }
})

const TONE: Record<MonitorUptimeDay['state'], string> = {
  up: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-error',
  // Alive, nothing asked of it. Dim rather than green: it is not evidence of
  // health, and claiming it is would overstate what a quiet weekend proves.
  quiet: 'bg-success/30',
  // Before collection started. Not a failure, and not a success.
  unknown: 'bg-elevated',
}

const LABEL: Record<MonitorUptimeDay['state'], string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  quiet: 'No traffic',
  unknown: 'Not measured',
}

function tooltip(day: MonitorUptimeDay): string {
  const date = new Date(day.day).toLocaleDateString(undefined, { dateStyle: 'medium' })
  const parts = [`${date} — ${LABEL[day.state]}`]

  if (day.requests) {
    parts.push(`${formatCount(day.requests)} requests`, `${formatRate(day.rate)} failed`)
  }

  if (day.state === 'down') {
    parts.push(`${1_440 - day.aliveMinutes} minutes missing`)
  }

  return parts.join(' · ')
}

/** `2h 14m`, because "134 minutes" is arithmetic the reader should not do. */
function duration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''

  try {
    data.value = await api.uptime()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not load uptime'
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-5">
    <header>
      <h1 class="text-lg font-semibold text-highlighted">
        Uptime
      </h1>
      <p class="text-sm text-dimmed">
        Measured from the application's own heartbeat, one per minute, and from the
        requests it answered. Ninety days, whatever window the rest of the dashboard is on.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      icon="i-lucide-triangle-alert"
    />

    <div v-else-if="loading && !data" class="space-y-3">
      <USkeleton class="h-24 w-full" />
      <USkeleton class="h-32 w-full" />
    </div>

    <div v-else-if="!observed.length" class="rounded-lg border border-dashed border-default py-14 text-center">
      <UIcon name="i-lucide-activity" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        Nothing measured yet.
      </p>
      <p class="mt-1 text-xs text-dimmed">
        The bar fills in from the minute collection starts.
      </p>
    </div>

    <template v-else>
      <section class="rounded-lg border border-default p-4">
        <div class="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <div class="flex items-center gap-2">
            <span
              class="size-2.5 rounded-full"
              :class="{
                'bg-success': current.tone === 'success',
                'bg-warning': current.tone === 'warning',
                'bg-error': current.tone === 'error',
                'bg-muted': current.tone === 'neutral',
              }"
            />
            <span class="font-medium text-highlighted">{{ current.label }}</span>
          </div>

          <div class="flex items-baseline gap-4 text-sm">
            <span class="text-dimmed">
              <span class="tabular-nums text-toned">{{ formatRate(data!.availability) }}</span>
              uptime
            </span>
            <span v-if="data!.errorRate !== undefined" class="text-dimmed">
              <span class="tabular-nums text-toned">{{ formatRate(data!.errorRate) }}</span>
              of requests failed
            </span>
          </div>
        </div>

        <!-- One cell per day. The bar is the point: ninety days of history read
             in a second, with the numbers underneath to explain what is seen. -->
        <div class="flex items-stretch gap-px overflow-hidden rounded">
          <span
            v-for="day in days"
            :key="day.day"
            class="h-9 min-w-0 flex-1 rounded-[1px] transition-opacity hover:opacity-70"
            :class="TONE[day.state]"
            :title="tooltip(day)"
          />
        </div>

        <div class="mt-2 flex items-center justify-between text-xs text-dimmed">
          <span>{{ days.length === 1 ? 'today' : `${days.length} days ago` }}</span>
          <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span v-for="state in (['up', 'degraded', 'down', 'quiet'] as const)" :key="state" class="flex items-center gap-1.5">
              <span class="size-2 rounded-sm" :class="TONE[state]" />{{ LABEL[state] }}
            </span>
          </span>
          <span>today</span>
        </div>
      </section>

      <section>
        <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
          Incidents
        </h2>

        <div v-if="!incidents.length" class="rounded-lg border border-dashed border-default py-10 text-center">
          <p class="text-sm text-muted">
            No gaps in the heartbeat.
          </p>
          <p class="mt-1 text-xs text-dimmed">
            Every minute since collection started is accounted for.
          </p>
        </div>

        <div v-else class="space-y-0.5">
          <div
            v-for="incident in incidents"
            :key="incident.from"
            class="flex items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-elevated/40"
          >
            <UIcon name="i-lucide-plug-zap" class="size-4 shrink-0 text-error" />
            <span class="shrink-0 tabular-nums text-toned">{{ duration(incident.minutes) }}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-dimmed" :title="absoluteTime(incident.from)">
              no heartbeat from {{ absoluteTime(incident.from) }}
            </span>
            <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(incident.to) }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
