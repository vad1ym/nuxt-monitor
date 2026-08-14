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

const busiest = computed(() =>
  props.cells.reduce((most, cell) => Math.max(most, cell.count), 0),
)

const total = computed(() => props.cells.reduce((sum, cell) => sum + cell.count, 0))

/** Sparse cells indexed for lookup, so the grid can be drawn dense. */
const counts = computed(() => {
  const map = new Map<number, number>()

  for (const cell of props.cells) {
    map.set(cell.day * 24 + cell.hour, cell.count)
  }

  return map
})

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
        <div class="flex gap-1">
          <!-- The day column, sized to match the rows beside it. -->
          <div class="flex shrink-0 flex-col gap-px pt-4">
            <span
              v-for="day in DAYS"
              :key="day.index"
              class="flex h-3.5 items-center text-[0.625rem] leading-none text-dimmed"
            >{{ day.label }}</span>
          </div>

          <div class="min-w-0 flex-1">
            <!-- Every sixth hour only. Twenty-four labels at this size overlap
                 into a grey smear, and the grid is read by position anyway. -->
            <div class="mb-1 flex h-3 gap-px">
              <span
                v-for="hour in HOURS"
                :key="hour"
                class="min-w-0 flex-1 text-[0.625rem] leading-none text-dimmed"
              >{{ hour % 6 === 0 ? String(hour).padStart(2, '0') : '' }}</span>
            </div>

            <div class="flex flex-col gap-px">
              <div v-for="day in DAYS" :key="day.index" class="flex gap-px">
                <span
                  v-for="hour in HOURS"
                  :key="hour"
                  class="h-3.5 min-w-0 flex-1 rounded-[2px]"
                  :class="toneOf(counts.get(day.index * 24 + hour) ?? 0)"
                  :title="labelOf(day, hour)"
                />
              </div>
            </div>
          </div>
        </div>

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
