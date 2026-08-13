<script setup lang="ts">
import type { EChartsType } from 'echarts/core'
import { PieChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cssColor } from '../chart'

/**
 * A composition, with the names beside it.
 *
 * A ring on its own is decoration: it shows that something is split without
 * saying what into. So the legend is not optional here — it carries the value,
 * the share and the count, and the ring is only the part that makes the
 * proportion readable at a glance.
 *
 * The hole is small and empty on purpose. It used to hold a total, which
 * repeated a number already on the card above and spent most of the widget's
 * area saying it twice.
 */
const props = defineProps<{
  slices: { value: string, count: number }[]
  /** Rendered beside a row when it adds something — usually a lift. */
  hint?: (value: string) => string | undefined
  size?: number
}>()

const emit = defineEmits<{ select: [value: string] }>()

use([CanvasRenderer, PieChart, TooltipComponent])

const element = ref<HTMLElement | null>(null)
let chart: EChartsType | undefined

/**
 * A fixed sequence rather than ECharts' default.
 *
 * Resolved to real colours before they are handed over: this renders to
 * canvas, where `var(--ui-primary)` is not a colour but a string the browser
 * cannot paint — the ring drew as invisible segments, which reads as a broken
 * chart rather than as a styling slip.
 */
const VARIABLES = [
  '--ui-primary',
  '--ui-info',
  '--ui-warning',
  '--ui-error',
  '--ui-success',
  '--ui-text-dimmed',
]

const colors = ref<string[]>([])

const total = computed(() => props.slices.reduce((sum, slice) => sum + slice.count, 0))

/** The legend rows, each carrying the colour of its arc. */
const legend = computed(() => props.slices.map((slice, index) => ({
  ...slice,
  color: colors.value[index % Math.max(1, colors.value.length)] ?? '#888',
  share: total.value ? slice.count / total.value : 0,
})))

function render(): void {
  if (!chart) {
    return
  }

  colors.value = VARIABLES.map(name => cssColor(name, '#888'))

  chart.setOption({
    animation: false,
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
      backgroundColor: cssColor('--ui-bg-elevated', '#222'),
      borderColor: cssColor('--ui-border', '#333'),
      textStyle: { color: cssColor('--ui-text', '#eee'), fontSize: 12 },
    },
    series: [{
      type: 'pie',
      // Thin, and close to the edge: the ring states a proportion, it is not a
      // container for a number. A fat ring around a hole full of text is two
      // widgets fighting over one square.
      radius: ['68%', '96%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: false,
      // The gap between segments is the page behind them, not a grey line.
      itemStyle: { borderColor: cssColor('--ui-bg', '#111'), borderWidth: 2 },
      label: { show: false },
      emphasis: { scale: false, itemStyle: { opacity: 0.85 } },
      data: props.slices.map((slice, index) => ({
        name: slice.value,
        value: slice.count,
        itemStyle: { color: colors.value[index % colors.value.length] },
      })),
    }],
  }, true)
}

onMounted(() => {
  if (!element.value) {
    return
  }

  chart = init(element.value, undefined, { renderer: 'canvas' })
  chart.on('click', (event: { name?: string }) => {
    if (event.name) {
      emit('select', event.name)
    }
  })

  render()
  window.addEventListener('resize', resize)
})

function resize(): void {
  chart?.resize()
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
})

watch(() => props.slices, render, { deep: true })
</script>

<template>
  <div class="flex items-center gap-3">
    <div
      ref="element"
      class="shrink-0"
      :style="{ width: `${size ?? 92}px`, height: `${size ?? 92}px` }"
    />

    <!-- The informative half. Rows are clickable for the same reason the arcs
         are: seeing a slice and wanting only that slice is one thought. -->
    <ul class="min-w-0 flex-1 space-y-0.5">
      <li v-for="row in legend" :key="row.value">
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-elevated/40"
          @click="emit('select', row.value)"
        >
          <span class="size-2 shrink-0 rounded-sm" :style="{ backgroundColor: row.color }" />
          <span class="min-w-0 flex-1 truncate text-sm text-toned">{{ row.value }}</span>
          <span v-if="hint?.(row.value)" class="shrink-0 text-xs tabular-nums text-warning">
            {{ hint(row.value) }}
          </span>
          <span class="w-8 shrink-0 text-end text-xs tabular-nums text-dimmed">
            {{ Math.round(row.share * 100) }}%
          </span>
          <span class="w-8 shrink-0 text-end text-sm tabular-nums text-highlighted">
            {{ row.count }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
