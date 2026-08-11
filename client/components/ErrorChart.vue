<script setup lang="ts">
import { computed } from 'vue'
import type { TrendPoint } from '../chart'
import { toColumns } from '../chart'
import TimeChart from './TimeChart.vue'

/**
 * Errors over time.
 *
 * Server and client are stacked rather than drawn side by side: the question
 * the overview asks first is "how much is broken right now", which is the
 * total, and the split is the follow-up. `toColumns` fills the gaps first —
 * the API returns only buckets that had events, so plotting it raw would draw
 * an hour of silence as a straight line between two spikes.
 */
const props = defineProps<{ trend: TrendPoint[], windowMs: number }>()

const columns = computed(() =>
  toColumns(props.trend, { now: Date.now(), windowMs: props.windowMs }),
)

const at = computed(() => columns.value.map(column => column.at))

const series = computed(() => [
  {
    name: 'server',
    values: columns.value.map(column => column.server),
    color: 'var(--ui-warning)',
  },
  {
    name: 'client',
    values: columns.value.map(column => column.client),
    color: 'var(--ui-info)',
  },
])
</script>

<template>
  <!-- Stacked: server and client errors add up to "how much is broken", and
       the total is the first thing the overview is asked for. -->
  <TimeChart
    :at="at"
    :series="series"
    stack
    empty-label="No errors in this window."
  />
</template>
