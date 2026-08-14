<script setup lang="ts">
import { computed } from 'vue'

/**
 * How a figure moved against the window before it.
 *
 * The tiles were all absolute, and an absolute number barely reads: "120
 * errors" is a quiet morning or a fire depending on whether the day before was
 * 15 or 400. The direction is the part somebody acts on.
 *
 * One component rather than the arithmetic repeated per tile, because the
 * subtle parts — which direction is good, what to do about division by zero,
 * when to say nothing at all — have to be decided identically everywhere or
 * the screen contradicts itself.
 */
const props = defineProps<{
  current: number
  /** The previous window's figure. Undefined when there was no window. */
  previous?: number
  /**
   * Whether going up is bad. True for errors and failure rates, false for
   * traffic — the same arrow means opposite things on the two, and colouring
   * a rise in requests red would call a good day an incident.
   */
  upIsBad?: boolean
  /**
   * Format for the tooltip's "was N" — the value is a count by default and a
   * rate on the failure-rate tile, where "was 0.03" would be unreadable.
   */
  format?: (value: number) => string
}>()

/**
 * Below this, a change is noise dressed as a finding.
 *
 * Percentages are violently unstable on small numbers: two errors against one
 * is +100%, and a tile shouting that every time a quiet app hiccups teaches
 * people to ignore the tile. The floor is on the *absolute* change, so a busy
 * app still reports its small percentages and a quiet one stays quiet.
 */
const MIN_ABSOLUTE = 3

/** Below this the percentage is not worth the ink either. */
const MIN_RATIO = 0.05

const delta = computed(() => {
  const previous = props.previous

  // No previous window at all: nothing to compare against, so say nothing.
  // Deliberately not "up ∞%" — see `previousTotals` on the server.
  if (previous === undefined) {
    return undefined
  }

  const change = props.current - previous

  if (change === 0) {
    return undefined
  }

  /**
   * A rise from nothing is reported as new rather than as a percentage.
   *
   * Dividing by zero gives Infinity, and "+∞%" is both useless and alarming.
   * "new" is what actually happened.
   */
  if (previous === 0) {
    return Math.abs(change) >= MIN_ABSOLUTE
      ? { up: true, label: 'new', previous }
      : undefined
  }

  const ratio = change / previous

  // Small in both senses, or it is noise. A change of 2 out of 4 is large by
  // ratio and meaningless in fact; a change of 2 out of 4000 is the reverse.
  if (Math.abs(change) < MIN_ABSOLUTE || Math.abs(ratio) < MIN_RATIO) {
    return undefined
  }

  return {
    up: change > 0,
    label: `${change > 0 ? '+' : '−'}${Math.round(Math.abs(ratio) * 100)}%`,
    previous,
  }
})

/**
 * Colour only when the direction is bad, never when it is good.
 *
 * A green badge on every improving tile turns the screen into a scoreboard,
 * and the eye stops finding the one red thing that matters. Neutral is the
 * default; red is reserved for "this got worse".
 */
const tone = computed(() => {
  if (!delta.value) {
    return ''
  }

  return delta.value.up === Boolean(props.upIsBad) ? 'text-error' : 'text-dimmed'
})

const title = computed(() => {
  if (!delta.value) {
    return undefined
  }

  const format = props.format ?? ((value: number) => String(value))

  return `Was ${format(delta.value.previous)} in the window before this one`
})
</script>

<template>
  <!-- Nothing at all when there is nothing to say: no previous window, no
       change, or a change too small to mean anything. An empty slot is
       quieter than "0%" and says the same thing. -->
  <span
    v-if="delta"
    class="inline-flex items-center gap-0.5 text-xs tabular-nums"
    :class="tone"
    :title="title"
  >
    <UIcon
      :name="delta.up ? 'i-lucide-trending-up' : 'i-lucide-trending-down'"
      class="size-3"
    />
    {{ delta.label }}
  </span>
</template>
