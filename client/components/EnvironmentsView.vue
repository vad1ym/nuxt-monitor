<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { MonitorFacetCounts, MonitorFacetName } from '../../lib/types'
import { api } from '../api'
import { formatShare } from '../chart'
import StatBar from './StatBar.vue'

const emit = defineEmits<{ browse: [facet: MonitorFacetName, value: string] }>()

/**
 * Where the application breaks.
 *
 * The same counts the filter panel is built from, read as a screen instead of
 * as a control. The panel answers "narrow this list"; this answers "who is
 * having a bad time", which is a product question as much as a debugging one —
 * whether to keep supporting an old Safari is decided from a column like this.
 */
const WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
]

const GROUPS: { name: MonitorFacetName, label: string, icon: string }[] = [
  { name: 'browser', label: 'Browser', icon: 'i-lucide-globe' },
  { name: 'browserVersion', label: 'Browser version', icon: 'i-lucide-hash' },
  { name: 'os', label: 'Operating system', icon: 'i-lucide-monitor' },
  { name: 'osVersion', label: 'OS version', icon: 'i-lucide-hash' },
  { name: 'deviceType', label: 'Device', icon: 'i-lucide-smartphone' },
]

const facets = ref<MonitorFacetCounts | null>(null)
const loading = ref(true)
const error = ref('')
const hours = ref(24)

async function load(): Promise<void> {
  loading.value = true

  error.value = ''

  try {
    facets.value = (await api.stats('environments', hours.value)).environments ?? null
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
          Environments
        </h1>
        <p class="text-sm text-dimmed">
          Which browsers, systems and devices the errors came from.
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

    <div v-else-if="loading" class="grid gap-6 sm:grid-cols-2">
      <USkeleton v-for="n in 4" :key="n" class="h-32 w-full" />
    </div>

    <div v-else-if="!facets?.browser.length" class="py-16 text-center">
      <UIcon name="i-lucide-monitor" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        No client errors in this window.
      </p>
      <p class="text-xs text-dimmed">
        Browser and OS are read from the request, so server-only errors show up here too.
      </p>
    </div>

    <div v-else class="grid gap-x-8 gap-y-6 sm:grid-cols-2">
      <section v-for="group in GROUPS" :key="group.name" class="space-y-1">
        <h2 class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-dimmed">
          <UIcon :name="group.icon" class="size-3.5" />
          {{ group.label }}
        </h2>

        <p v-if="!facets[group.name].length" class="px-2 py-1 text-xs text-dimmed">
          Nothing recorded.
        </p>

        <button
          v-for="row in facets[group.name]"
          v-else
          :key="row.value"
          type="button"
          class="block w-full text-left cursor-pointer"
          @click="emit('browse', group.name, row.value)"
        >
          <StatBar
            :share="row.share"
            :label="row.value"
            :value="String(row.count)"
            :hint="formatShare(row.share)"
            mono
          />
        </button>
      </section>
    </div>
  </div>
</template>
