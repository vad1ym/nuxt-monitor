import { defineAsyncComponent, h } from 'vue'

/**
 * `TimeChart`, and ECharts with it, fetched only when a chart is on screen.
 *
 * ECharts is by far the heaviest thing the dashboard imports — roughly two
 * thirds of the bundle — and every screen was paying for it. The issue *list*
 * is the page people spend most of their time on and it draws no chart at all,
 * so the cost fell hardest on the view that never uses it.
 *
 * Split here rather than inside `TimeChart.vue`: the component itself is
 * small, and it is the static `import` of it that pulls the library into the
 * main chunk. An async import at every call site would split it just as well
 * and would repeat the reasoning three times.
 *
 * Props and slots pass through untouched, so this stays a drop-in for the
 * component it wraps — no second copy of the prop types to drift from the
 * first.
 */
const TimeChart = defineAsyncComponent({
  loader: () => import('./TimeChart.vue'),
  /**
   * A box the size of the chart, rather than a spinner.
   *
   * The chart lands within a few hundred milliseconds on any connection that
   * loaded the dashboard at all, and the thing that reads as broken is not the
   * wait — it is the page height jumping when the chart arrives and shoves
   * everything below it down. A placeholder that reserves the space keeps the
   * layout still.
   *
   * `height` is read off the props so the placeholder matches whichever size
   * the caller asked for; the default mirrors the component's own.
   */
  loadingComponent: {
    props: { height: { type: String, default: 'h-40' } },
    setup: (props: { height: string }) => () =>
      h('div', { class: `${props.height} rounded bg-elevated/20` }),
  },
  /**
   * Nothing at all when the chunk cannot be fetched.
   *
   * A failed lazy import is almost always a stale hash after a deploy, and the
   * next navigation fixes it. An error box in place of a chart would claim the
   * data itself is broken, which is a worse lie than a missing decoration on a
   * page whose numbers are all still correct.
   */
  errorComponent: { render: () => null },
  // Long enough that a slow connection still gets the chart rather than the
  // error component, since the error state here is "give up".
  timeout: 20_000,
})

export default TimeChart
