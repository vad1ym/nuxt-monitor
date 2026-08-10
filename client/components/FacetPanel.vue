<script setup lang="ts">
import { computed } from 'vue'
import type { MonitorFacetCounts, MonitorFacetFilter, MonitorFacetName } from '../../lib/types'
import { formatShare } from '../chart'

/**
 * Facet panel.
 *
 * The value of a facet list is comparison, so every row shows its share as a
 * bar behind the label: "which browser is this" is answered by the shape of
 * the column, not by reading seven numbers. Selected values stay visible even
 * when a sibling filter pushes their count to zero — a filter you cannot see
 * is a filter you cannot undo.
 */
const props = defineProps<{
  facets: MonitorFacetCounts | null
  loading?: boolean
}>()

const model = defineModel<MonitorFacetFilter>({ required: true })

const GROUPS: { name: MonitorFacetName, label: string, icon: string }[] = [
  { name: 'browser', label: 'Browser', icon: 'i-lucide-globe' },
  { name: 'browserVersion', label: 'Browser version', icon: 'i-lucide-hash' },
  { name: 'os', label: 'OS', icon: 'i-lucide-monitor' },
  { name: 'osVersion', label: 'OS version', icon: 'i-lucide-hash' },
  { name: 'deviceType', label: 'Device', icon: 'i-lucide-smartphone' },
  { name: 'release', label: 'Release', icon: 'i-lucide-tag' },
  { name: 'route', label: 'Route', icon: 'i-lucide-route' },
]

/**
 * A dimension with one value tells you nothing — everything is that value.
 * Hidden unless it is filtered on, so the panel shows only what can be acted
 * on rather than a column of ones.
 */
const groups = computed(() =>
  GROUPS
    .map(group => ({ ...group, values: props.facets?.[group.name] ?? [] }))
    .filter(group => group.values.length > 1 || model.value[group.name]?.length),
)

const activeCount = computed(() =>
  Object.values(model.value).reduce((sum, values) => sum + (values?.length ?? 0), 0),
)

function isSelected(name: MonitorFacetName, value: string): boolean {
  return Boolean(model.value[name]?.includes(value))
}

/** Selecting is a toggle: the same click that adds a value removes it. */
function toggle(name: MonitorFacetName, value: string): void {
  const current = model.value[name] ?? []
  const next = current.includes(value)
    ? current.filter(item => item !== value)
    : [...current, value]

  const updated = { ...model.value }

  if (next.length) {
    updated[name] = next
  }
  else {
    // Dropped rather than left empty, so an untouched facet and a cleared one
    // produce the same request.
    delete updated[name]
  }

  model.value = updated
}

function clear(): void {
  model.value = {}
}

</script>

<template>
  <div class="space-y-5">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
        Filters
      </h2>

      <UButton
        v-if="activeCount"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        :label="`Clear ${activeCount}`"
        @click="clear"
      />
    </div>

    <div v-if="loading && !facets" class="space-y-2">
      <USkeleton v-for="n in 4" :key="n" class="h-6 w-full" />
    </div>

    <p v-else-if="!groups.length" class="text-xs text-dimmed">
      Not enough variety to filter by yet.
    </p>

    <section v-for="group in groups" :key="group.name" class="space-y-1">
      <h3 class="flex items-center gap-1.5 text-xs font-medium text-muted">
        <UIcon :name="group.icon" class="size-3.5 text-dimmed" />
        {{ group.label }}
      </h3>

      <ul>
        <li v-for="row in group.values" :key="row.value">
          <button
            type="button"
            class="relative w-full flex items-center gap-2 overflow-hidden rounded px-1.5 py-1 text-left text-xs transition-colors cursor-pointer"
            :class="isSelected(group.name, row.value)
              ? 'text-highlighted'
              : 'text-toned hover:bg-elevated/40'"
            :aria-pressed="isSelected(group.name, row.value)"
            @click="toggle(group.name, row.value)"
          >
            <!-- The bar is the comparison; it sits behind the text so the row
                 stays one line and reads as a label, not a chart. -->
            <span
              class="absolute inset-y-0 start-0 -z-10 rounded"
              :class="isSelected(group.name, row.value) ? 'bg-primary/25' : 'bg-elevated/60'"
              :style="{ width: `${Math.max(row.share * 100, 1.5)}%` }"
            />

            <UIcon
              v-if="isSelected(group.name, row.value)"
              name="i-lucide-check"
              class="size-3 shrink-0 text-primary"
            />

            <span class="min-w-0 flex-1 truncate font-mono">{{ row.value }}</span>

            <span class="shrink-0 tabular-nums text-dimmed">{{ formatShare(row.share) }}</span>
            <span class="w-8 shrink-0 text-end tabular-nums text-muted">{{ row.count }}</span>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
