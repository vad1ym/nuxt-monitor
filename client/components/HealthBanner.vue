<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { MonitorHealth } from '../../lib/types'
import { api } from '../api'
import { formatBytes } from '../format'

/**
 * What is wrong with the collector itself.
 *
 * An empty issue list means one thing when collection is healthy and something
 * else entirely when the database stopped accepting writes an hour ago — and
 * from a dashboard the two look identical. So this sits above every screen and
 * says nothing at all while there is nothing to say.
 */
const health = ref<(MonitorHealth & { storageDir?: string }) | null>(null)

/** Failures worth interrupting for, worst first. */
const problem = computed(() => {
  const state = health.value

  if (!state) {
    return null
  }

  if (!state.enabled) {
    return {
      color: 'error' as const,
      icon: 'i-lucide-database-backup',
      title: 'Collection is off — nothing is being recorded.',
      detail: state.reason
        ? `The database could not be opened: ${state.reason}`
        : 'The database could not be opened.',
    }
  }

  if (state.retryAfter > Date.now()) {
    return {
      color: 'error' as const,
      icon: 'i-lucide-database',
      title: 'Writes are failing.',
      detail: `${state.pending} event${state.pending === 1 ? '' : 's'} are waiting in memory`
        + `${state.dropped > 0 ? ` and ${state.dropped} have been dropped` : ''}.`,
    }
  }

  if (state.dropped > 0) {
    return {
      color: 'warning' as const,
      icon: 'i-lucide-trash-2',
      title: `${state.dropped} event${state.dropped === 1 ? '' : 's'} could not be written.`,
      detail: 'They were dropped to keep the application from running out of memory.',
    }
  }

  if (state.overCeiling) {
    return {
      color: 'warning' as const,
      icon: 'i-lucide-hard-drive',
      title: 'The storage ceiling is too low for this much traffic.',
      detail: `${formatBytes(state.bytes)} stored against a limit of ${formatBytes(state.maxBytes)}. `
        + 'Only the most recent events are kept — raise `maxDatabaseMb`.',
    }
  }

  return null
})

let timer: ReturnType<typeof setInterval> | undefined

async function load(): Promise<void> {
  try {
    health.value = await api.health()
  }
  catch {
    // A failing health check is not itself worth a banner: the rest of the
    // dashboard already shows an error when the session or the server is gone.
  }
}

onMounted(() => {
  load()

  // Slow on purpose. This exists to catch a condition that lasts, not to
  // watch a counter.
  timer = setInterval(load, 60_000)
})

onUnmounted(() => clearInterval(timer))
</script>

<template>
  <UAlert
    v-if="problem"
    :color="problem.color"
    :icon="problem.icon"
    variant="subtle"
    :title="problem.title"
    :description="problem.detail"
    class="mb-4"
  />
</template>
