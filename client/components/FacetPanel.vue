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

function selectedCount(name: MonitorFacetName): number {
  return model.value[name]?.length ?? 0
}

/**
 * What the closed control says.
 *
 * The value itself when one is chosen, because a dropdown labelled "Browser"
 * hides the fact that it is filtering — and a filter you cannot see is a
 * filter you cannot undo.
 */
function summary(name: MonitorFacetName, label: string): string {
  const active = model.value[name] ?? []

  if (!active.length) {
    return label
  }

  return active.length === 1 ? active[0]! : `${label}: ${active.length}`
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
  <div class="flex flex-wrap items-center gap-1.5">
    <div v-if="loading && !facets" class="flex gap-1.5">
      <USkeleton v-for="n in 4" :key="n" class="h-6 w-24" />
    </div>

    <p v-else-if="!groups.length" class="text-xs text-dimmed">
      Not enough variety to filter by yet.
    </p>

    <UPopover v-for="group in groups" v-else :key="group.name">
      <UButton
        size="xs"
        :color="selectedCount(group.name) ? 'primary' : 'neutral'"
        :variant="selectedCount(group.name) ? 'subtle' : 'outline'"
        :icon="group.icon"
        :label="summary(group.name, group.label)"
        trailing-icon="i-lucide-chevron-down"
        class="max-w-56"
      />

      <template #content>
        <ul class="w-64 max-h-72 overflow-y-auto p-1">
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
                   stays one line and reads as a label, not a chart.

                   Layered by source order inside the row rather than with a
                   negative z-index: the button paints no stacking context of
                   its own, so `-z-10` sent the bar behind the popover panel
                   and it showed only during the open transition, while the
                   panel still had one. -->
              <span
                class="absolute inset-y-0 start-0 rounded"
                :class="isSelected(group.name, row.value) ? 'bg-primary/25' : 'bg-elevated/60'"
                :style="{ width: `${Math.max(row.share * 100, 1.5)}%` }"
              />

              <UIcon
                v-if="isSelected(group.name, row.value)"
                name="i-lucide-check"
                class="relative size-3 shrink-0 text-primary"
              />

              <span class="relative min-w-0 flex-1 truncate font-mono">{{ row.value }}</span>

              <span class="relative shrink-0 tabular-nums text-dimmed">{{ formatShare(row.share) }}</span>
              <span class="relative w-8 shrink-0 text-end tabular-nums text-muted">{{ row.count }}</span>
            </button>
          </li>
        </ul>
      </template>
    </UPopover>

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
</template>
