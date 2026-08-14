<script setup lang="ts">
import { computed } from 'vue'
import type { MonitorHeatCell } from '../../lib/types'
import { formatCount } from '../chart'

/**
 * When errors happen, by hour of the week.
 *
 * A time chart answers "how much, lately". This answers "when, always" — and
 * they disagree in the case that matters: a fault confined to the nightly
 * batch, or to office hours, is a low flat line on the trend and an obvious
 * bright band here. The shape is the finding, which is why it is a grid rather
 * than 168 numbers.
 *
 * Sparse in, dense out: the query returns only cells that had events, and a
 * grid drawn from those alone would have no shape at all — the empty hours are
 * half of what the picture says.
 */
const props = defineProps<{
  cells: MonitorHeatCell[]
  /** Shown when there is nothing to draw yet. */
  emptyLabel?: string
}>()

/**
 * Monday first.
 *
 * The data numbers days from Sunday because `getDay()` does, but a week that
 * starts on Sunday splits the weekend across both edges of the grid — and
 * "quiet at the weekend" is one of the two or three patterns anybody comes
 * here to see. Kept as a lookup rather than a rotation so the mapping is
 * visible in one line.
 */
const DAYS = [
  { index: 1, label: 'Mon' },
  { index: 2, label: 'Tue' },
  { index: 3, label: 'Wed' },
  { index: 4, label: 'Thu' },
  { index: 5, label: 'Fri' },
  { index: 6, label: 'Sat' },
  { index: 0, label: 'Sun' },
]

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

const total = computed(() => props.cells.reduce((sum, cell) => sum + cell.count, 0))

/**
 * Absolute hours folded into the local weekday-and-hour grid.
 *
 * This is the step that has to happen here rather than on the server: an hour
 * is a moment, and which weekday and which hour that moment falls on depends
 * entirely on where the person reading is. `getDay()` and `getHours()` answer
 * in the browser's own zone, which is the whole point — the server used to
 * answer in *its* zone, so a team spread across two of them read two different
 * pictures from one dataset, and the one conclusion the grid offers ("this
 * only happens at night") was wrong for whoever was not sitting next to the
 * server.
 */
const counts = computed(() => {
  const map = new Map<number, number>()

  for (const cell of props.cells) {
    const at = new Date(cell.at)
    const key = at.getDay() * 24 + at.getHours()

    map.set(key, (map.get(key) ?? 0) + cell.count)
  }

  return map
})

/**
 * The fullest cell, measured after folding rather than before.
 *
 * Two absolute hours can land in the same local cell — 168 buckets, a week of
 * data, and any zone at all — so the largest incoming bucket is not the
 * largest drawn one. Taking the max from the raw cells understated the top of
 * the scale, which left the darkest cell short of full colour and the legend
 * claiming a number smaller than one the grid actually contains.
 */
const busiest = computed(() =>
  [...counts.value.values()].reduce((most, count) => Math.max(most, count), 0),
)

/**
 * One hue, light to dark — the rule for a magnitude scale.
 *
 * Five steps rather than a continuous opacity, because a reader compares cells
 * by matching shades, and a continuous ramp offers 40 shades nobody can tell
 * apart. Banding also survives the case this chart is worst at: one enormous
 * cell flattening everything else to invisible.
 *
 * Ranked by share of the busiest cell rather than by absolute count, so the
 * picture is about *when*, which is the question. The scale is stated in the
 * legend, since a colour with no key is a decoration.
 */
const STEPS = [
  'bg-primary/10',
  'bg-primary/30',
  'bg-primary/50',
  'bg-primary/70',
  'bg-primary',
]

function toneOf(count: number): string {
  if (!count) {
    // Not the first step of the ramp: "none" has to be legible as none, or an
    // empty hour and a quiet one look like the same thing.
    return 'bg-elevated/40'
  }

  const share = count / (busiest.value || 1)
  const step = Math.min(STEPS.length - 1, Math.floor(share * STEPS.length))

  return STEPS[step]!
}

function labelOf(day: { index: number, label: string }, hour: number): string {
  const count = counts.value.get(day.index * 24 + hour) ?? 0
  const hours = `${String(hour).padStart(2, '0')}:00`

  return count
    ? `${day.label} ${hours} — ${formatCount(count)} ${count === 1 ? 'error' : 'errors'}`
    : `${day.label} ${hours} — nothing`
}
</script>

<template>
  <div>
    <p v-if="!total" class="py-6 text-center text-xs text-dimmed">
      {{ emptyLabel ?? 'Nothing recorded yet.' }}
    </p>

    <div v-else class="overflow-x-auto">
      <!-- Min width rather than squeezing: below it the cells stop being
           comparable, and a grid whose cells cannot be compared is not doing
           the one thing it exists for. Scrolls on a narrow screen instead. -->
      <div class="min-w-[34rem]">
        <!-- A real table, not a stack of divs.
             The grid *is* a table — a value at the intersection of a weekday
             and an hour — and saying so in the markup is what lets a screen
             reader walk it by row and column and hear the headers with each
             cell. As divs the entire content was carried by `title` and a
             background colour: unreachable by keyboard, invisible to a reader,
             and gone in forced-colours mode. -->
        <table class="w-full border-separate border-spacing-px">
          <caption class="sr-only">
            Errors by hour of the week, in your timezone. Rows are days, columns are hours.
          </caption>

          <thead>
            <tr>
              <!-- The corner above the day labels. -->
              <td class="w-8" />
              <!-- Every sixth hour is shown; the rest are labelled for
                   assistive tech only, so the column keeps its header without
                   twenty-four numbers smearing into each other on screen. -->
              <th
                v-for="hour in HOURS"
                :key="hour"
                scope="col"
                class="pb-1 text-[0.625rem] font-normal leading-none text-dimmed"
              >
                <span v-if="hour % 6 === 0">{{ String(hour).padStart(2, '0') }}</span>
                <span v-else class="sr-only">{{ String(hour).padStart(2, '0') }}</span>
              </th>
            </tr>
          </thead>

          <tbody>
            <tr v-for="day in DAYS" :key="day.index">
              <th
                scope="row"
                class="w-8 pe-1 text-end text-[0.625rem] font-normal leading-none text-dimmed"
              >
                {{ day.label }}
              </th>
              <td
                v-for="hour in HOURS"
                :key="hour"
                class="h-3.5 rounded-[2px]"
                :class="toneOf(counts.get(day.index * 24 + hour) ?? 0)"
                :title="labelOf(day, hour)"
              >
                <!-- The count in text, for anything that cannot see a colour.
                     Visually hidden rather than omitted: the shade carries it
                     for sighted readers, and colour alone is never an
                     accessible encoding. -->
                <span class="sr-only">{{ labelOf(day, hour) }}</span>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- The key. A shade without one is decoration, and this ramp is
             relative to the busiest hour rather than to a count, which nobody
             would guess. -->
        <div class="mt-2 flex items-center justify-end gap-1.5 text-[0.625rem] text-dimmed">
          <span>none</span>
          <span class="size-3 rounded-[2px] bg-elevated/40" />
          <span v-for="step in STEPS" :key="step" class="size-3 rounded-[2px]" :class="step" />
          <span>{{ formatCount(busiest) }}/hour</span>
        </div>
      </div>
    </div>
  </div>
</template>
