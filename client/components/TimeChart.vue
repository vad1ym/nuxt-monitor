<script setup lang="ts">
import type { EChartsType } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cssColor, resolveColor } from '../chart'
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
  /**
   * Vertical lines at moments worth naming — deploys, in practice.
   *
   * Drawn on the same axis as the data rather than beside it, because the
   * question they answer is about shape: how much was happening before the
   * line against how much after. A separate list of deploy times leaves the
   * reader to do that comparison from memory.
   */
  markers?: {
    at: number
    label: string
    title?: string
    /**
     * Colour role, so a marker can say what kind of moment it is.
     *
     * Deploys are the neutral default. A resolve and the regression that
     * refuted it are the two moments on this chart somebody acted on, and
     * drawing them in the same grey as a deploy makes the chart's most
     * loaded pair of lines the least visible thing on it.
     */
    tone?: 'neutral' | 'success' | 'warning'
  }[]
  /**
   * Tailwind height class for the plot.
   *
   * A chart that shares a row with something else has to match its neighbour's
   * height, and the overview's full-width charts want more room than a
   * side-by-side one does.
   */
  height?: string
}>()

/**
 * Registered piecewise rather than importing `echarts` whole.
 *
 * Anything added here is paid for by every chart, so add deliberately.
 */
use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, MarkLineComponent])

const container = ref<HTMLElement>()
const empty = ref(false)

let chart: EChartsType | null = null
let observer: ResizeObserver | null = null

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

/**
 * The column a moment belongs to.
 *
 * The x-axis is a category axis whose categories are bucket timestamps, so a
 * marker cannot be placed at an arbitrary time — it has to name a category
 * that exists. The bucket a deploy fell *inside* is the honest one: the last
 * column whose start is at or before it. Rounding to the nearest instead would
 * put a deploy at 10:59 in the 11:00 column and draw the line to the right of
 * errors it actually preceded, which inverts the only thing the marker is
 * there to show.
 *
 * Returns the category *index*, not the timestamp. A category axis compares
 * its values as strings, so handing `markLine` the bucket number matched
 * nothing and the lines silently did not draw — an index is unambiguous.
 */
function columnFor(at: number): number | undefined {
  let found: number | undefined

  props.at.forEach((bucket, index) => {
    if (bucket <= at) {
      found = index
    }
  })

  return found
}

/**
 * Deploy lines, as a series of their own.
 *
 * On its own series rather than attached to a data series: a `markLine` hangs
 * off whatever series carries it, so putting it on `errors` would make the
 * lines disappear the moment somebody hides that series — and the deploy did
 * not stop happening because the reader turned off a legend entry.
 */
function markLineSeries(): Record<string, unknown>[] {
  const markers = props.markers ?? []

  if (!markers.length || !props.at.length) {
    return []
  }

  const neutral = cssColor('--ui-text-dimmed', '#71717a')
  const tones: Record<string, string> = {
    neutral,
    success: cssColor('--ui-success', '#22c55e'),
    warning: cssColor('--ui-warning', '#f59e0b'),
  }

  const located = markers
    .map(marker => ({ marker, column: columnFor(marker.at) }))
    .filter((entry): entry is { marker: typeof markers[number], column: number } =>
      entry.column !== undefined)
    .sort((a, b) => a.column - b.column)

  /**
   * Markers sharing a column, merged into one.
   *
   * Two moments inside the same bucket are the same vertical line — there is
   * no x-position that separates them. Drawn as two, ECharts stacks them at
   * one point and only the last label survives, which on a resolve followed
   * seconds later by the regression that refuted it silently hides half of
   * the most important pair on the chart. One line labelled "resolved · came
   * back" says what actually happened: both, too close together for this
   * chart to separate.
   *
   * The tone of the last one wins, because these read as a sequence and the
   * last is where it ended up — an issue resolved and then regressed is
   * currently a regression.
   */
  const placed = located.reduce<{ column: number, marker: typeof markers[number] }[]>((into, entry) => {
    const last = into.at(-1)

    if (last?.column !== entry.column) {
      into.push({ column: entry.column, marker: entry.marker })
      return into
    }

    last.marker = {
      ...entry.marker,
      label: `${last.marker.label} · ${entry.marker.label}`,
      title: [last.marker.title, entry.marker.title].filter(Boolean).join('\n'),
    }

    return into
  }, [])

  if (!placed.length) {
    return []
  }

  /**
   * How far apart two labels have to be before they can share a line.
   *
   * Measured in columns, because that is the only unit available here — a
   * label's pixel width is not knowable until ECharts lays it out. Roughly
   * the width of a trimmed release name at this font size against the span
   * the chart draws, floored at 2 so a short chart still staggers neighbours.
   */
  const clearance = Math.max(2, Math.ceil(props.at.length / 8))

  // The vertical slot each label sits in.
  //
  // Two markers a minute apart land in the same column, and `insideEndTop`
  // put both labels at the same point — they overprinted into an unreadable
  // smear, which on an issue that was resolved and immediately regressed is
  // exactly the pair you most need to read. Stepping a colliding label down
  // by a line costs a little vertical room and makes both legible.
  //
  // Each label is pushed below the lowest one it still overlaps, rather than
  // simply alternating: three markers in a cluster need three slots, and
  // alternating would collide the first with the third.
  const rows: number[] = []
  let lastColumn = Number.NEGATIVE_INFINITY
  let row = 0

  for (const { column } of placed) {
    row = column - lastColumn < clearance ? row + 1 : 0
    rows.push(row)
    lastColumn = column
  }

  const data = placed.map(({ marker, column }, index) => {
    // A label near the right edge has to grow inward.
    //
    // Labels are drawn to the right of their line, so one on the last few
    // columns runs straight off the plot and is clipped mid-word — and the
    // markers that land there are the recent ones, which is where a resolve
    // and the regression that followed it invariably sit. Flipping the
    // alignment puts the text on the other side of the same line.
    const atEnd = column > props.at.length - 1 - clearance
    const color = tones[marker.tone ?? 'neutral'] ?? neutral

    return {
      // The index into `xAxis.data` — see `columnFor`.
      xAxis: column,
      // Carried through so the label formatter can reach it — ECharts hands
      // the formatter the data item, not the original marker.
      name: marker.label,
      // What the line cannot say by itself: whether the deploy brought
      // anything with it. Read by the tooltip formatter below.
      value: marker.title ?? marker.label,
      lineStyle: { color },
      label: {
        color,
        align: atEnd ? 'right' : 'left',
        // One text line per slot, plus the gap the label already had. The
        // horizontal half flips sign with the alignment, so the gap stays on
        // the outside of the line either way.
        distance: [atEnd ? -2 : 2, 4 + rows[index]! * 13],
      },
    }
  })

  return [{
    type: 'line',
    name: 'deploys',
    // Nulls rather than an empty array: a series with no data is not laid out
    // against the axis, and ECharts then has nothing to hang the `markLine`
    // on — the lines silently do not appear. One null per category costs
    // nothing to draw and gives the series the axis extent it needs.
    data: props.at.map(() => null),
    silent: true,
    markLine: {
      symbol: 'none',
      silent: false,
      lineStyle: { color: neutral, type: 'dashed', width: 1, opacity: 0.9 },
      label: {
        show: true,
        position: 'insideEndTop',
        color: neutral,
        fontSize: 10,
        // Horizontal, explicitly. ECharts rotates a vertical `markLine`'s
        // label to run along the line, which puts the release name on its
        // side — legible only to somebody willing to tilt their head.
        rotate: 0,
        // Clear of the line itself, and of the chart's top edge. Overridden
        // per marker above, to step colliding labels apart.
        distance: [2, 4],
        align: 'left',
        verticalAlign: 'top',
        // Painted so a label crossing the plot line stays readable. Without
        // it a name drawn over the series is two colours fighting in the same
        // pixels, which is half of why the overlapping pair was a smear.
        backgroundColor: cssColor('--ui-bg', '#09090b'),
        padding: [1, 3],
        borderRadius: 2,
        // The release name, trimmed. A commit SHA is 40 characters and would
        // cover the chart it is annotating; the first seven are what people
        // paste to each other anyway.
        //
        // Only for a single unbroken token, which is what a SHA is. A label
        // built from several words — "resolved · came back", where two
        // moments shared a column — is long because it says more, and cutting
        // it to seven characters would throw away the half that was merged in.
        formatter: ({ name }: { name: string }) =>
          name.length > 12 && !name.includes(' ') ? `${name.slice(0, 7)}…` : name,
      },
      emphasis: { disabled: true },
      // The axis tooltip cannot reach a `markLine` — it reports the series
      // under the cursor — so the line carries its own, triggered by hovering
      // the line itself.
      tooltip: {
        trigger: 'item',
        formatter: ({ value }: { value: string }) => value,
      },
      data,
    },
  }]
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
      const color = resolveColor(series.color)

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
    }).concat(markLineSeries() as never[]),
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
  () => [props.at, props.series.map(series => series.values), props.markers],
  render,
  { deep: true },
)
</script>

<template>
  <div class="relative" :class="height ?? 'h-40'">
    <div ref="container" class="size-full" />

    <p
      v-if="empty && emptyLabel"
      class="absolute inset-0 grid place-items-center text-xs text-dimmed pointer-events-none"
    >
      {{ emptyLabel }}
    </p>
  </div>
</template>
