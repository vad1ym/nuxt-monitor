<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MonitorRouteStat } from '../../lib/types'
import { api } from '../api'
import { formatCount, formatShare } from '../chart'

/**
 * Every route, by failure rate.
 *
 * The overview shows the worst five, which answers "what is on fire". This
 * answers the slower question — which endpoints are worth attention — so
 * healthy routes are listed too: a high-traffic route at 0% is the context
 * that makes 4% on a quiet one readable.
 */
/** The window is the application's, not this screen's — see `App.vue`. */
const props = defineProps<{ hours: number }>()

const routes = ref<MonitorRouteStat[]>([])
const loading = ref(true)
const error = ref('')

const peak = computed(() => Math.max(1, ...routes.value.map(route => route.total)))

/** Anything failing at all, worst first — the list is already sorted that way. */
const failing = computed(() => routes.value.filter(route => route.failed > 0))

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
    routes.value = (await api.stats('routes', props.hours)).routes ?? []
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
        Requests and failure rate per endpoint. Static assets are not counted —
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

    <div v-else-if="loading" class="space-y-2">
      <USkeleton v-for="n in 5" :key="n" class="h-8 w-full" />
    </div>

    <div v-else-if="!routes.length" class="py-16 text-center">
      <UIcon name="i-lucide-route" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        No requests counted in this window.
      </p>
    </div>

    <template v-else>
      <p v-if="failing.length" class="text-xs text-dimmed">
        {{ failing.length }} of {{ routes.length }}
        {{ routes.length === 1 ? 'route is' : 'routes are' }} failing.
      </p>

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
    </template>
  </div>
</template>
