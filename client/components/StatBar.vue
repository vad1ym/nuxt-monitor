<script setup lang="ts">
/**
 * A value with a proportional bar behind it.
 *
 * Numbers in a column are read one at a time; a bar is read all at once. Used
 * across the section screens so "which of these is big" never requires
 * arithmetic.
 */
defineProps<{
  /** 0–1. Width of the bar. */
  share: number
  label: string
  /** Right-aligned figure, already formatted. */
  value: string
  /** Second figure, dimmer — usually the share as a percentage. */
  hint?: string
  /** Colours the bar when the row is a problem rather than just a quantity. */
  tone?: 'neutral' | 'warning' | 'error'
  mono?: boolean
}>()
</script>

<template>
  <div class="relative flex items-center gap-2 overflow-hidden rounded px-2 py-1.5 text-sm">
    <span
      class="absolute inset-y-0 start-0 -z-10 rounded"
      :class="{
        'bg-elevated/60': !tone || tone === 'neutral',
        'bg-warning/20': tone === 'warning',
        'bg-error/25': tone === 'error',
      }"
      :style="{ width: `${Math.max(share * 100, 1.5)}%` }"
    />

    <span class="min-w-0 flex-1 truncate" :class="mono ? 'font-mono text-toned' : 'text-toned'">
      {{ label }}
    </span>

    <span v-if="hint" class="shrink-0 text-xs tabular-nums text-dimmed">{{ hint }}</span>
    <span class="w-14 shrink-0 text-end tabular-nums text-highlighted">{{ value }}</span>
  </div>
</template>
