<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MonitorSessionStats } from '../../lib/types'
import { api } from '../api'
import { formatCount } from '../chart'
import { relativeTime } from '../format'
import StatBar from './StatBar.vue'

/**
 * How many people, rather than how many errors.
 *
 * An event count cannot tell an outage from one person stuck in a retry loop,
 * and those need opposite responses. A session is a random per-tab id — it
 * groups events and identifies nobody — so this is the closest honest answer
 * to "how many people hit this".
 */
const WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
]

const stats = ref<MonitorSessionStats | null>(null)
const loading = ref(true)
const error = ref('')
const hours = ref(24)

const perSession = computed(() => {
  const data = stats.value

  return data?.affected ? data.events / data.affected : undefined
})

const peak = computed(() =>
  Math.max(1, ...(stats.value?.worst ?? []).map(row => row.events)),
)

/**
 * Only sessions that stand out.
 *
 * "Worst affected" listing twenty rows of one event each is not a ranking, it
 * is an arbitrary sample of everybody — and it buries the two sessions that
 * actually saw something repeatedly. A session is only interesting here if it
 * saw more than one error.
 */
const worst = computed(() => (stats.value?.worst ?? []).filter(row => row.events > 1))

/** Many events across few sessions is a loop, not an outage. */
const looping = computed(() => (perSession.value ?? 0) >= 5)

async function load(): Promise<void> {
  loading.value = true

  error.value = ''

  try {
    stats.value = (await api.stats('sessions', hours.value)).sessions ?? null
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

watch(hours, load)
onMounted(load)
</script>

<template>
  <div class="space-y-5">
    <header class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-lg font-semibold text-highlighted">
          Sessions
        </h1>
        <p class="text-sm text-dimmed">
          How many people saw an error, and who saw the most.
        </p>
      </div>

      <UButtonGroup size="xs">
        <UButton
          v-for="option in WINDOWS"
          :key="option.hours"
          :color="hours === option.hours ? 'primary' : 'neutral'"
          :variant="hours === option.hours ? 'subtle' : 'ghost'"
          :label="option.label"
          @click="hours = option.hours"
        />
      </UButtonGroup>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      icon="i-lucide-triangle-alert"
    />

    <div v-else-if="loading" class="space-y-3">
      <USkeleton class="h-20 w-full" />
      <USkeleton class="h-40 w-full" />
    </div>

    <div v-else-if="!stats?.affected" class="py-16 text-center">
      <UIcon name="i-lucide-users" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        No affected sessions in this window.
      </p>
      <p class="text-xs text-dimmed">
        Sessions are recorded for browser errors only — a server error belongs to a request.
      </p>
    </div>

    <template v-else>
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-lg border border-default px-4 py-3">
          <p class="text-xs text-dimmed">
            Affected sessions
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums text-highlighted">
            {{ formatCount(stats.affected) }}
          </p>
        </div>

        <div class="rounded-lg border border-default px-4 py-3">
          <p class="text-xs text-dimmed">
            Client errors
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums text-highlighted">
            {{ formatCount(stats.events) }}
          </p>
        </div>

        <div class="rounded-lg border border-default px-4 py-3">
          <p class="text-xs text-dimmed">
            Errors per session
          </p>
          <p
            class="mt-1 text-2xl font-semibold tabular-nums"
            :class="looping ? 'text-warning' : 'text-highlighted'"
          >
            {{ perSession ? perSession.toFixed(1) : '—' }}
          </p>
        </div>
      </div>

      <!-- The distinction worth spelling out, when it applies. -->
      <div
        v-if="looping"
        class="flex items-start gap-2.5 rounded-lg border border-default bg-elevated/40 px-3 py-2.5"
      >
        <UIcon name="i-lucide-repeat" class="mt-0.5 size-4 shrink-0 text-warning" />
        <p class="text-sm text-toned">
          <strong class="font-semibold text-highlighted">Errors are repeating</strong>
          <span class="text-dimmed">
            · {{ formatCount(stats.events) }} events across only
            {{ formatCount(stats.affected) }} sessions, so this is fewer people hitting the
            same thing rather than many people affected.
          </span>
        </p>
      </div>

      <section class="space-y-1">
        <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
          Repeatedly affected
        </h2>

        <p v-if="!worst.length" class="px-2 py-1 text-xs text-dimmed">
          No session saw more than one error — the failures are spread across
          people rather than concentrated on a few.
        </p>

        <StatBar
          v-for="row in worst"
          :key="row.session"
          :share="row.events / peak"
          :label="row.session"
          :value="String(row.events)"
          :hint="`${row.issues} ${row.issues === 1 ? 'issue' : 'issues'} · ${relativeTime(row.lastSeen)}`"
          :tone="row.events >= 20 ? 'warning' : 'neutral'"
          mono
        />
      </section>
    </template>
  </div>
</template>
