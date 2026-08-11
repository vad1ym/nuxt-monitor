<script setup lang="ts">
import { computed } from 'vue'
import type { MonitorFacetCounts, MonitorFacetFilter } from '../../lib/types'
import { dominantSlice, facetLabel } from '../dominant'
import FacetPanel from './FacetPanel.vue'

/**
 * What these occurrences have in common.
 *
 * The panel below is the evidence; the line above it is the point. A table of
 * ten rows makes a reader do the arithmetic that produced it, so the one
 * conclusion worth drawing is stated in words and the table is left as
 * supporting detail.
 */
const props = defineProps<{
  facets: MonitorFacetCounts | null
  /** Same facets across all traffic, so a slice can be judged against normal. */
  baseline?: MonitorFacetCounts | null
  /** Distinct sessions behind the occurrences. */
  sessionCount: number
  eventCount: number
  loading?: boolean
  /**
   * Renders the sentence without the table under it.
   *
   * The two halves want opposite positions on the page. The conclusion belongs
   * above the stack — it is one line and it frames everything below it. The
   * table is evidence, and evidence that pushes the failing line of code off
   * the screen has cost more than it gave.
   */
  findingOnly?: boolean
  /** The table without the sentence, for the other end of the page. */
  panelOnly?: boolean
}>()

/** Passed through from the panel: only the page that fetches can widen a list. */
const emit = defineEmits<{ expand: [] }>()

const filter = defineModel<MonitorFacetFilter>('filter', { required: true })

const filtered = computed(() => Object.keys(filter.value).length > 0)

/**
 * Suppressed while a filter is active.
 *
 * Every remaining facet reads 100% once you have narrowed to a slice, so the
 * sentence would confidently report back the filter you just applied.
 */
const dominant = computed(() =>
  filtered.value ? undefined : dominantSlice(props.facets, props.baseline),
)

/**
 * Events per session, when both are known.
 *
 * The distinction the roadmap is after: 250 events across 3 sessions is one
 * person in a retry loop, across 250 sessions it is everybody.
 */
const perSession = computed(() =>
  props.sessionCount > 0 ? props.eventCount / props.sessionCount : undefined,
)

/**
 * Many occurrences from very few sessions.
 *
 * Checked before the dominant slice, and it wins when both apply. A handful of
 * people in a retry loop are usually all on one browser, so the environment
 * facet reads 100% and looks like a finding — but "everyone affected uses
 * Chrome" says nothing when "everyone" is two people. The repeat count is the
 * fact that actually changes what you do about it.
 */
const repeats = computed(() => !filtered.value && (perSession.value ?? 0) >= 5)

const finding = computed(() => {
  if (repeats.value) {
    return 'repeats' as const
  }

  return dominant.value ? 'dominant' as const : undefined
})
</script>

<template>
  <div class="space-y-4">
    <!-- The conclusion, in a sentence. Only shown when there is one. -->
    <div
      v-if="!panelOnly && finding === 'dominant' && dominant"
      class="flex items-start gap-2.5 rounded-lg border border-default bg-elevated/40 px-3 py-2.5"
    >
      <UIcon name="i-lucide-crosshair" class="mt-0.5 size-4 shrink-0 text-primary" />

      <p class="text-sm text-toned">
        <strong class="font-semibold text-highlighted">
          {{ Math.round(dominant.share * 100) }}% on {{ dominant.label }}
        </strong>
        <span class="text-dimmed">
          · {{ facetLabel(dominant.facet) }} · {{ dominant.count }} of {{ eventCount }}
          <template v-if="sessionCount">
            · {{ sessionCount }} {{ sessionCount === 1 ? 'session' : 'sessions' }}
          </template>
        </span>
      </p>
    </div>

    <!-- Says the opposite thing, and is just as actionable: a handful of
         people hitting the same error over and over is not an outage. -->
    <div
      v-else-if="!panelOnly && finding === 'repeats'"
      class="flex items-start gap-2.5 rounded-lg border border-default bg-elevated/40 px-3 py-2.5"
    >
      <UIcon name="i-lucide-repeat" class="mt-0.5 size-4 shrink-0 text-warning" />

      <p class="text-sm text-toned">
        <strong class="font-semibold text-highlighted">
          {{ Math.round(perSession!) }}× per session
        </strong>
        <span class="text-dimmed">
          · {{ eventCount }} occurrences across only
          {{ sessionCount }} {{ sessionCount === 1 ? 'session' : 'sessions' }}
        </span>
      </p>
    </div>

    <FacetPanel
      v-if="!findingOnly"
      v-model="filter"
      :facets="facets"
      :loading="loading"
      @expand="emit('expand')"
    />
  </div>
</template>
