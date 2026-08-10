<script setup lang="ts">
import { computed } from 'vue'
import type { TrendPoint } from '../chart'
import { toColumns } from '../chart'
import { absoluteTime } from '../format'

/**
 * Errors over time, drawn as plain elements.
 *
 * One chart does not justify a charting library in a bundle we ship to every
 * consumer — and a stacked bar per bucket is a handful of divs.
 */
const props = defineProps<{ trend: TrendPoint[], windowMs: number }>()

const columns = computed(() =>
  toColumns(props.trend, { now: Date.now(), windowMs: props.windowMs }),
)

const empty = computed(() => columns.value.every(column => column.total === 0))

function label(column: { at: number, server: number, client: number }): string {
  return `${absoluteTime(column.at)} — ${column.server} server, ${column.client} client`
}
</script>

<template>
  <div class="relative h-24">
    <div class="flex h-full items-end gap-px">
      <div
        v-for="(column, index) in columns"
        :key="index"
        class="group relative flex-1 h-full flex flex-col justify-end"
        :title="label(column)"
      >
        <!-- A hairline keeps empty buckets visible, so a gap reads as a gap
             rather than as the chart ending. -->
        <div
          v-if="column.total === 0"
          class="h-px w-full bg-muted/40 rounded-sm"
        />

        <template v-else>
          <div
            v-if="column.client"
            class="w-full bg-info rounded-t-sm"
            :style="{ height: `${(column.client / column.total) * column.height * 100}%` }"
          />
          <div
            v-if="column.server"
            class="w-full bg-warning"
            :class="column.client ? '' : 'rounded-t-sm'"
            :style="{ height: `${(column.server / column.total) * column.height * 100}%` }"
          />
        </template>
      </div>
    </div>

    <p
      v-if="empty"
      class="absolute inset-0 grid place-items-center text-xs text-dimmed pointer-events-none"
    >
      No errors in this window.
    </p>
  </div>
</template>
