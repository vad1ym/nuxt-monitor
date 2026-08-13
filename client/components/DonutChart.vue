<script setup lang="ts">
import type { EChartsType } from 'echarts/core'
import { PieChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cssColor } from '../chart'

/**
 * A composition, in one glance.
 *
 * Used where the question is "what is this made of" and the answer has a
 * handful of parts — API against pages, one device class against another. A
 * bar list answers "which is biggest" better; a ring answers "is this split
 * even or lopsided" better, and that is the question these are asked.
 *
 * The middle is not decoration: the total goes there, so the chart carries the
 * number it is a breakdown of rather than making the reader look elsewhere.
 */
const props = defineProps<{
  slices: { value: string, count: number, color?: string }[]
  /** Shown in the hole. Usually the total, already formatted. */
  total?: string
  label?: string
  height?: number
}>()

const emit = defineEmits<{ select: [value: string] }>()

use([CanvasRenderer, PieChart, TooltipComponent])

const element = ref<HTMLElement | null>(null)
let chart: EChartsType | undefined

/**
 * A fixed sequence rather than ECharts' default.
 *
 * The dashboard's palette is one accent plus greys, and a ring in six unrelated
 * hues reads as a different application.
 *
 * Resolved to real colours before they are handed over: this renders to canvas,
 * where a `var(--ui-primary)` is not a colour but a string the browser cannot
 * paint — the ring drew as six invisible segments, which reads as a broken
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

function palette(): string[] {
  return VARIABLES.map(name => cssColor(name, '#888'))
}

function render(): void {
  if (!chart) {
    return
  }

  const colors = palette()

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
      // A ring rather than a full circle: the hole holds the total, and a
      // filled pie invites comparing angles, which people do badly.
      radius: ['62%', '88%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: false,
      // The gap between segments is the page behind them, not a grey line.
      itemStyle: { borderColor: cssColor('--ui-bg', '#111'), borderWidth: 2 },
      label: { show: false },
      emphasis: { scale: false, itemStyle: { opacity: 0.85 } },
      data: props.slices.map((slice, index) => ({
        name: slice.value,
        value: slice.count,
        itemStyle: { color: slice.color ?? colors[index % colors.length] },
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
  <div class="relative">
    <div ref="element" :style="{ height: `${height ?? 160}px` }" />

    <!-- The total in the hole, so the ring carries the number it divides. -->
    <div
      v-if="total"
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
    >
      <span class="text-lg font-semibold tabular-nums text-highlighted">{{ total }}</span>
      <span v-if="label" class="text-xs text-dimmed">{{ label }}</span>
    </div>
  </div>
</template>
