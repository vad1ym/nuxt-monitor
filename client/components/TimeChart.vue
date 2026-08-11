<script setup lang="ts">
import type { EChartsType } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { absoluteTime } from '../format'

/**
 * A stacked area chart over time, and the only place ECharts is configured.
 *
 * Every chart on the dashboard goes through here, so the axes, the grid and
 * the tooltip are decided once — two charts describing the same window must
 * not disagree about how time is drawn.
 *
 * Driven imperatively rather than through a reactive `:option` binding. Bound
 * reactively, the option object is rebuilt on every render of this component,
 * and hovering *is* a render — so moving the mouse across the chart handed
 * ECharts a brand-new option mid-interaction and the series vanished, leaving
 * bare axes and a tooltip. `setOption` is called only when the data actually
 * changes, which is the one thing that should redraw it.
 */
const props = defineProps<{
  /** X values, in milliseconds. */
  at: number[]
  /** Drawn in the order given; bottom to top when stacked. */
  series: { name: string, values: number[], color: string }[]
  /**
   * Stack the series into one total instead of drawing them independently.
   *
   * Only correct when the parts add up to something worth reading — server
   * plus client errors is "how much is broken". It is wrong wherever a line
   * has to match its own number: stacked, the upper line is drawn at the sum,
   * so a bucket with 3 ok and 0 failed puts the red line at 3 and reads as
   * three failures.
   */
  stack?: boolean
  /** Shown centred when every series is empty. */
  emptyLabel?: string
}>()

/**
 * Registered piecewise rather than importing `echarts` whole.
 *
 * Anything added here is paid for by every chart, so add deliberately.
 */
use([CanvasRenderer, LineChart, GridComponent, TooltipComponent])

const container = ref<HTMLElement>()
const empty = ref(false)

let chart: EChartsType | null = null
let observer: ResizeObserver | null = null

/**
 * Colours come from the stylesheet, not from a palette hardcoded here.
 *
 * ECharts paints on a canvas, where `var(--ui-warning)` is just a string it
 * cannot resolve — it silently draws nothing. So the variables are read from
 * the document and passed as real colours. The alternative is duplicating the
 * theme in JavaScript, where it quietly drifts from the rest of the dashboard.
 */
function cssColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim()

  return value || fallback
}

/** `var(--x)` from a caller, resolved; anything else passed through. */
function resolve(color: string): string {
  const match = /^var\((--[^),]+)\)$/.exec(color.trim())

  return match ? cssColor(match[1]!, color) : color
}

/**
 * An axis label, cut to what the span it covers actually needs.
 *
 * The tooltip spells the bucket out in full, so the axis only has to say where
 * you are: `14:20` over an afternoon, `Mar 3` over a week. A full locale date
 * and time at either scale is a wall of text that has to be measured rather
 * than read, and at three labels across it wraps.
 */
function axisTime(timestamp: number): string {
  const spanMs = (props.at.at(-1) ?? 0) - (props.at[0] ?? 0)
  const date = new Date(timestamp)

  return spanMs > 48 * 60 * 60 * 1_000
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function render(): void {
  if (!chart) {
    return
  }

  empty.value = props.series.every(series => series.values.every(value => value === 0))

  const muted = cssColor('--ui-text-muted', '#71717a')
  const border = cssColor('--ui-border', '#27272a')

  chart.setOption({
    animation: false,

    // The chart is the whole card; padding belongs to the card around it.
    // `containLabel` keeps the axis labels inside that box rather than
    // letting them overflow it.
    grid: { top: 8, right: 4, bottom: 20, left: 4, containLabel: true },

    tooltip: {
      trigger: 'axis',
      backgroundColor: cssColor('--ui-bg-elevated', '#18181b'),
      borderColor: border,
      textStyle: { color: cssColor('--ui-text-highlighted', '#fafafa'), fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: border } },
      formatter: (params: { dataIndex: number, seriesName: string, value: number, color: string }[]) => {
        if (!Array.isArray(params) || !params.length) {
          return ''
        }

        const index = params[0]!.dataIndex
        const rows = params
          .map(item =>
            `<div style="display:flex;gap:6px;align-items:center">
               <span style="width:6px;height:6px;border-radius:2px;background:${item.color}"></span>
               <span>${item.seriesName}</span>
               <b style="margin-left:auto">${item.value}</b>
             </div>`)
          .join('')

        return `<div style="font-size:11px">
                  <div style="margin-bottom:4px;opacity:0.7">${absoluteTime(props.at[index] ?? 0)}</div>
                  ${rows}
                </div>`
      },
    },

    xAxis: {
      type: 'category',
      // The bucket timestamps are the categories; the labels below are what
      // the reader sees, and there are far too many buckets to label them all.
      data: props.at,
      boundaryGap: false,
      axisLine: { lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: {
        color: muted,
        fontSize: 10,
        // Three labels across the axis: start, middle, end. Enough to place
        // the shape in time without turning the axis into a wall of text.
        interval: (index: number) => index === 0
          || index === props.at.length - 1
          || index === Math.floor((props.at.length - 1) / 2),
        formatter: (value: string) => axisTime(Number(value)),
      },
    },

    yAxis: {
      type: 'value',
      // Whole counts only: "1.5 errors" is not a thing that happened.
      minInterval: 1,
      splitLine: { lineStyle: { color: border, type: 'dashed' } },
      axisLabel: { color: muted, fontSize: 10 },
    },

    series: props.series.map((series) => {
      const color = resolve(series.color)

      return {
        name: series.name,
        type: 'line',
        ...(props.stack ? { stack: 'total' } : {}),
        smooth: 0.35,
        showSymbol: false,
        // Emphasis off. On hover ECharts re-renders the hovered series with
        // its emphasis state, and with `stack` + `smooth` that pass dropped
        // the line and area entirely — leaving bare axes, a tooltip and two
        // marker dots. Nothing here needs a hover style: the tooltip already
        // says what the point is.
        emphasis: { disabled: true },
        lineStyle: { width: 1.5, color },
        itemStyle: { color },
        // Unstacked series overlap, so the fill has to be light enough to see
        // the one behind it; stacked bands sit apart and can take more.
        areaStyle: { color, opacity: props.stack ? 0.18 : 0.12 },
        data: series.values,
      }
    }),
    // Replaced wholesale: series merged by index would leave the tail of a
    // longer previous window drawn under a shorter one.
  }, true)
}

onMounted(() => {
  if (!container.value) {
    return
  }

  chart = init(container.value)
  render()

  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(container.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  chart?.dispose()
  chart = null
})

// The data, and nothing else. Not a deep watch on the whole prop object: the
// parent rebuilds these arrays on every fetch, and redrawing on identity alone
// would throw away the tooltip mid-hover.
watch(
  () => [props.at, props.series.map(series => series.values)],
  render,
  { deep: true },
)
</script>

<template>
  <div class="relative h-40">
    <div ref="container" class="size-full" />

    <p
      v-if="empty && emptyLabel"
      class="absolute inset-0 grid place-items-center text-xs text-dimmed pointer-events-none"
    >
      {{ emptyLabel }}
    </p>
  </div>
</template>
