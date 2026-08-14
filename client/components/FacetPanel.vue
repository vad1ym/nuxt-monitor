<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
 *
 * Tabs rather than a row of dropdowns. Every value was one click away and
 * therefore invisible: the panel rendered as four closed buttons above an
 * empty box, occupying a card's worth of screen to show nothing at all, and
 * answering "which browsers is this happening on" needed a click and a
 * dismissal per dimension. With the first dimension open by default the panel
 * is showing an answer the moment the page loads, and the space it was already
 * taking is the space the values go in.
 */
const props = defineProps<{
  facets: MonitorFacetCounts | null
  loading?: boolean
}>()

/**
 * Asks the parent to refetch with room for more values.
 *
 * The panel does not fetch its own counts — they arrive with the rest of the
 * screen and are filtered by the same window — so widening the list is a
 * request, not something it can do alone.
 */
const emit = defineEmits<{ expand: [] }>()

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
    .map(group => ({
      ...group,
      values: props.facets?.[group.name]?.values ?? [],
      more: props.facets?.[group.name]?.more ?? false,
    }))
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
 * Which dimension is open.
 *
 * Held by name rather than by index so it survives `groups` changing under it:
 * filtering can drop a dimension to a single value, which hides it, and an
 * index would then silently point at a different facet than the one the reader
 * chose.
 */
const active = ref<MonitorFacetName | undefined>()

/**
 * The open dimension, falling back to the first one there is.
 *
 * A tab strip with nothing selected is the dropdown problem again — a control
 * that shows no data until it is clicked. The fallback is computed rather than
 * assigned so it also covers the first render, when the counts have not
 * arrived and there is no group to select yet.
 */
const current = computed(() =>
  groups.value.find(group => group.name === active.value) ?? groups.value[0],
)

// A dimension that disappears takes the selection with it, rather than leaving
// `active` pointing at a facet the panel no longer shows.
watch(groups, (list) => {
  if (active.value && !list.some(group => group.name === active.value)) {
    active.value = undefined
  }
})

/** Selecting is a toggle: the same click that adds a value removes it. */
function toggle(name: MonitorFacetName, value: string): void {
  const selected = model.value[name] ?? []
  const next = selected.includes(value)
    ? selected.filter(item => item !== value)
    : [...selected, value]

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
  <!-- A flex column, so a caller can fix the height and have the values scroll
       inside rather than overflow the card they are in. -->
  <div class="flex min-h-0 flex-col gap-2">
    <div v-if="loading && !facets" class="flex gap-1.5">
      <USkeleton v-for="n in 4" :key="n" class="h-6 w-24" />
    </div>

    <p v-else-if="!groups.length" class="text-xs text-dimmed">
      Not enough variety to filter by yet.
    </p>

    <template v-else>
      <div class="flex shrink-0 flex-wrap items-center gap-1">
        <button
          v-for="group in groups"
          :key="group.name"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors cursor-pointer"
          :class="group.name === current?.name
            ? 'bg-elevated text-highlighted'
            : 'text-dimmed hover:bg-elevated/50 hover:text-toned'"
          :aria-pressed="group.name === current?.name"
          @click="active = group.name"
        >
          <UIcon :name="group.icon" class="size-3.5 shrink-0" />
          {{ group.label }}
          <!-- The count of what is filtering, on the tab it belongs to. A
               selection made on one dimension is invisible from another, and
               a filter you cannot see is a filter you cannot undo — which was
               the one thing the dropdown labels did well. -->
          <UBadge
            v-if="selectedCount(group.name)"
            color="primary"
            variant="subtle"
            size="sm"
            :label="String(selectedCount(group.name))"
          />
        </button>

        <UButton
          v-if="activeCount"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          :label="`Clear ${activeCount}`"
          class="ms-auto"
          @click="clear"
        />
      </div>

      <!-- `min-h-0` is what makes the scroll happen: a flex item's default
           minimum size is its content, so without it the list grows the column
           instead of scrolling inside it. No `max-h` — the height belongs to
           whichever card this is placed in, and a cap here would leave a strip
           of empty card below a list that is still scrolling. -->
      <ul v-if="current" class="min-h-0 flex-1 space-y-px overflow-y-auto pe-1">
        <li v-for="row in current.values" :key="row.value">
          <button
            type="button"
            class="relative w-full flex items-center gap-2 overflow-hidden rounded px-1.5 py-1 text-left text-xs transition-colors cursor-pointer"
            :class="isSelected(current.name, row.value)
              ? 'text-highlighted'
              : 'text-toned hover:bg-elevated/40'"
            :aria-pressed="isSelected(current.name, row.value)"
            @click="toggle(current.name, row.value)"
          >
            <!-- The bar is the comparison; it sits behind the text so the row
                 stays one line and reads as a label, not a chart.

                 Layered by source order inside the row rather than with a
                 negative z-index: the button paints no stacking context of its
                 own, so `-z-10` would send the bar behind its own container. -->
            <span
              class="absolute inset-y-0 start-0 rounded"
              :class="isSelected(current.name, row.value) ? 'bg-primary/25' : 'bg-elevated/60'"
              :style="{ width: `${Math.max(row.share * 100, 1.5)}%` }"
            />

            <UIcon
              v-if="isSelected(current.name, row.value)"
              name="i-lucide-check"
              class="relative size-3 shrink-0 text-primary"
            />

            <span class="relative min-w-0 flex-1 truncate font-mono">{{ row.value }}</span>

            <span class="relative shrink-0 tabular-nums text-dimmed">{{ formatShare(row.share) }}</span>
            <span class="relative w-8 shrink-0 text-end tabular-nums text-muted">{{ row.count }}</span>
          </button>
        </li>

        <!-- Said out loud rather than left to a scrollbar that stops: a list
             silently cut at twenty reads as the whole set, and the values
             below the cut are the rare ones worth finding. -->
        <li v-if="current.more" class="border-t border-default mt-1 pt-1">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            block
            :loading="loading"
            label="Show more"
            @click="emit('expand')"
          />
        </li>
      </ul>
    </template>
  </div>
</template>
