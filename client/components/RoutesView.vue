<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MonitorTrafficStats } from '../../lib/types'
import { api } from '../api'
import { formatCount, formatRate, formatShare } from '../chart'
import TimeChart from './TimeChart.vue'

/**
 * What the application is serving, and how much of it fails.
 *
 * A list of routes on its own could not answer the questions a traffic screen
 * exists for — whether the app is busy at all, whether failures are faults or
 * bad requests, when they happened. Those are properties of the total, and no
 * per-route row carries them, so they sit above the table.
 *
 * Healthy routes stay listed: a high-traffic route at 0% is the context that
 * makes 4% on a quiet one readable.
 */
const props = defineProps<{ hours: number }>()

const data = ref<MonitorTrafficStats | null>(null)
const loading = ref(true)
const error = ref('')

const routes = computed(() => data.value?.routes ?? [])

const peak = computed(() => Math.max(1, ...routes.value.map(route => route.total)))

const failing = computed(() => routes.value.filter(route => route.failed > 0))

/**
 * Status classes in a fixed order, with meaning attached.
 *
 * `4xx` and `5xx` both count as "not a success" and mean opposite things: one
 * is the caller's mistake, the other the application's. Shown apart rather
 * than summed into a single failure number.
 */
const CLASSES = [
  { key: '2xx', label: 'OK', tone: 'text-success' },
  { key: '3xx', label: 'Redirect', tone: 'text-muted' },
  { key: '4xx', label: 'Client error', tone: 'text-warning' },
  { key: '5xx', label: 'Server error', tone: 'text-error' },
]

const classes = computed(() =>
  CLASSES
    .map(item => ({ ...item, count: data.value?.classes[item.key] ?? 0 }))
    .filter(item => item.count > 0),
)

/**
 * Traffic over time, plotted on the buckets the API already grouped.
 *
 * Not re-bucketed on the way in: `stats/traffic` regroups the per-minute
 * counters into the same 48 slots the chart draws, so running them through a
 * second grid built from `Date.now()` only misaligns them — the slots fall
 * between the client's columns and every one of them reads as zero, which is
 * a chart of a flat line at the bottom of an axis that still says 8.
 */
const traffic = computed(() => {
  const trend = data.value?.trend ?? []

  return {
    at: trend.map(point => point.bucket),
    // The API sends `total` with `failed` inside it, so the successful count
    // is the difference. Both lines then carry their own number, which is
    // what the tooltip shows and what the reader compares.
    ok: trend.map(point => Math.max(0, point.total - point.failed)),
    failed: trend.map(point => point.failed),
  }
})

/** Green reads as "these succeeded", which is what the line counts. */
const trafficSeries = computed(() => [
  { name: 'ok', values: traffic.value.ok, color: 'var(--ui-success)' },
  { name: '5xx', values: traffic.value.failed, color: 'var(--ui-error)' },
])

function tone(rate: number): 'neutral' | 'warning' | 'error' {
  if (rate >= 0.05) {
    return 'error'
  }

  return rate > 0 ? 'warning' : 'neutral'
}

async function load(): Promise<void> {
  loading.value = true

  error.value = ''

  try {
    data.value = (await api.stats('traffic', props.hours)).traffic ?? null
  }
  catch (caught) {
    // Silence here would show an empty screen, which reads as 'no data'
    // rather than 'the request failed'.
    error.value = caught instanceof Error ? caught.message : 'Could not load this section'
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
        Traffic
      </h1>
      <p class="text-sm text-dimmed">
        Every request the application answered. Static assets are not counted —
        they are not endpoints, and one page view drags dozens in.
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
      <USkeleton class="h-20 w-full" />
      <USkeleton class="h-24 w-full" />
      <USkeleton class="h-40 w-full" />
    </div>

    <div v-else-if="!data?.total" class="py-16 text-center">
      <UIcon name="i-lucide-route" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        No requests counted in this window.
      </p>
    </div>

    <template v-else>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="rounded-lg border border-default p-3">
          <p class="text-xs text-dimmed">
            Requests
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums text-highlighted">
            {{ formatCount(data.total) }}
          </p>
          <p class="text-xs text-dimmed">
            across {{ routes.length }} {{ routes.length === 1 ? 'endpoint' : 'endpoints' }}
          </p>
        </div>

        <div class="rounded-lg border border-default p-3">
          <p class="text-xs text-dimmed">
            Failure rate
          </p>
          <p
            class="mt-1 text-2xl font-semibold tabular-nums"
            :class="(data.rate ?? 0) > 0.05 ? 'text-error' : 'text-highlighted'"
          >
            {{ formatRate(data.rate) }}
          </p>
          <p class="text-xs text-dimmed">
            {{ formatCount(data.failed) }} answered 5xx
          </p>
        </div>

        <div class="rounded-lg border border-default p-3">
          <p class="text-xs text-dimmed">
            Failing endpoints
          </p>
          <p
            class="mt-1 text-2xl font-semibold tabular-nums"
            :class="failing.length ? 'text-warning' : 'text-highlighted'"
          >
            {{ failing.length }}
          </p>
          <p class="text-xs text-dimmed">
            of {{ routes.length }}
          </p>
        </div>

        <div class="rounded-lg border border-default p-3">
          <p class="text-xs text-dimmed">
            Methods
          </p>
          <div class="mt-1.5 flex flex-wrap gap-1">
            <UBadge
              v-for="method in data.methods.slice(0, 4)"
              :key="method.method"
              color="neutral"
              variant="subtle"
              size="sm"
              :label="`${method.method} ${formatCount(method.count)}`"
            />
          </div>
        </div>
      </div>

      <!-- Where the responses landed. 4xx and 5xx are kept apart: one is the
           caller's mistake, the other the application's. -->
      <section v-if="classes.length" class="rounded-lg border border-default p-3">
        <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
          Responses
        </h2>

        <div class="flex h-2 overflow-hidden rounded-full bg-elevated/60">
          <span
            v-for="item in classes"
            :key="item.key"
            :style="{ width: `${(item.count / data.total) * 100}%` }"
            :class="{
              'bg-success': item.key === '2xx',
              'bg-muted': item.key === '3xx',
              'bg-warning': item.key === '4xx',
              'bg-error': item.key === '5xx',
            }"
            :title="`${item.label}: ${item.count}`"
          />
        </div>

        <div class="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <span v-for="item in classes" :key="item.key" class="flex items-center gap-1.5">
            <span
              class="size-2 rounded-sm"
              :class="{
                'bg-success': item.key === '2xx',
                'bg-muted': item.key === '3xx',
                'bg-warning': item.key === '4xx',
                'bg-error': item.key === '5xx',
              }"
            />
            <span class="font-mono" :class="item.tone">{{ item.key }}</span>
            <span class="text-dimmed">{{ item.label }}</span>
            <span class="tabular-nums text-muted">{{ formatCount(item.count) }}</span>
            <span class="tabular-nums text-dimmed">{{ formatShare(item.count / data.total) }}</span>
          </span>
        </div>
      </section>

      <!-- Volume over time, with the failing share stacked on top of it: a
           spike in errors during a spike in traffic is a different story from
           the same spike on a quiet hour. -->
      <section v-if="data.trend.length > 1" class="rounded-lg border border-default p-3">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Requests over time
          </h2>
          <div class="flex items-center gap-3 text-xs text-dimmed">
            <span class="flex items-center gap-1.5">
              <span class="size-2 rounded-sm bg-success" />ok
            </span>
            <span class="flex items-center gap-1.5">
              <span class="size-2 rounded-sm bg-error" />5xx
            </span>
          </div>
        </div>

        <TimeChart :at="traffic.at" :series="trafficSeries" />
      </section>

      <section class="space-y-1">
        <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
          Endpoints
        </h2>

        <div class="space-y-0.5">
          <div
            v-for="route in routes"
            :key="route.route"
            class="relative flex items-center gap-3 overflow-hidden rounded px-2 py-1.5 text-sm"
          >
            <!-- Width is traffic, colour is health: a wide grey bar is a busy
                 route that works, a narrow red one is a quiet route that does not. -->
            <span
              class="absolute inset-y-0 start-0 -z-10 rounded"
              :class="{
                'bg-elevated/60': tone(route.rate) === 'neutral',
                'bg-warning/20': tone(route.rate) === 'warning',
                'bg-error/25': tone(route.rate) === 'error',
              }"
              :style="{ width: `${(route.total / peak) * 100}%` }"
            />

            <span class="min-w-0 flex-1 truncate font-mono text-toned">{{ route.route }}</span>

            <span class="hidden shrink-0 gap-1 sm:flex">
              <span
                v-for="method in route.methods?.slice(0, 3)"
                :key="method"
                class="rounded bg-elevated/70 px-1 font-mono text-[10px] leading-4 text-dimmed"
              >{{ method }}</span>
            </span>

            <!-- 4xx shown beside 5xx rather than folded into one number: a
                 route that only 404s is not a route that is broken. -->
            <span class="w-12 shrink-0 text-end tabular-nums text-xs text-warning">
              {{ route.classes?.['4xx'] ? formatCount(route.classes['4xx']) : '' }}
            </span>

            <span
              class="w-14 shrink-0 text-end tabular-nums text-xs"
              :class="route.failed ? 'text-error' : 'text-dimmed'"
            >
              {{ route.failed ? formatShare(route.rate) : '—' }}
            </span>

            <span class="w-16 shrink-0 text-end tabular-nums text-muted">
              {{ formatCount(route.total) }}
            </span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
