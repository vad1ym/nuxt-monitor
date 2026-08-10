<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MonitorFrame } from '../../lib/types'
import { groupFrames, shortPath } from '../frames'

/**
 * Renders a stack trace so the application frame is the thing you see.
 *
 * Library frames are collapsed into a single row per run: a Vue render error
 * arrives with a dozen `runtime-core` frames around the one line that belongs
 * to the reader, and showing them all with equal weight is what makes a trace
 * unreadable.
 *
 * Everything is interpolated as text, never markup: messages and source
 * excerpts are untrusted input.
 */
const props = defineProps<{ frames: MonitorFrame[], raw?: string }>()

const groups = computed(() => groupFrames(props.frames))
const expanded = ref(new Set<number>())

function toggle(index: number): void {
  const next = new Set(expanded.value)

  next.has(index) ? next.delete(index) : next.add(index)
  expanded.value = next
}

function frameLabel(frame: MonitorFrame): string {
  return frame.original?.function ?? frame.function ?? '<anonymous>'
}

function location(frame: MonitorFrame): string {
  const file = frame.original?.file ?? frame.file
  const line = frame.original?.line ?? frame.line
  const column = frame.original?.column ?? frame.column

  return `${shortPath(file)}:${line}:${column}`
}
</script>

<template>
  <div v-if="groups.length" class="space-y-1.5">
    <template v-for="(group, index) in groups" :key="index">
      <!-- Application frame: the reader's own code, shown with its source. -->
      <div
        v-if="group.kind === 'app'"
        class="rounded-lg border border-default overflow-hidden"
      >
        <div class="flex flex-wrap items-baseline gap-x-2 px-3 py-2 bg-elevated/40">
          <UIcon name="i-lucide-code" class="size-3.5 text-primary self-center" />
          <span class="font-mono text-sm text-highlighted">{{ location(group.frame) }}</span>
          <span class="text-xs text-muted">in {{ frameLabel(group.frame) }}</span>
          <!-- Beside the path, not pushed to the far edge: this qualifies the
               location, and on a wide row `ms-auto` parked it so far away
               that it read as unrelated — or scrolled out of sight. -->
          <UBadge
            v-if="!group.frame.original"
            color="neutral"
            variant="subtle"
            size="sm"
            :label="group.frame.unresolved === 'no-map' ? 'no map' : 'unmapped'"
            :title="group.frame.unresolved === 'no-map'
              ? 'No sourcemap for this file was found — probably a different build'
              : 'The sourcemap covers no position here'"
          />
        </div>

        <div
          v-if="group.frame.original?.context"
          class="overflow-x-auto text-xs font-mono leading-[1.6] py-1"
        >
          <div
            v-for="entry in group.frame.original.context"
            :key="entry.line"
            class="flex whitespace-pre"
            :class="entry.line === group.frame.original.line
              ? 'bg-primary/15 border-s-2 border-primary'
              : 'border-s-2 border-transparent'"
          >
            <span class="w-12 shrink-0 pe-3 text-right text-dimmed select-none">{{ entry.line }}</span>
            <span :class="entry.line === group.frame.original.line ? 'text-highlighted' : 'text-toned'">{{ entry.text }}</span>
          </div>
        </div>

        <!-- Three different failures, and they need different words. An
             unmapped frame's line number counts lines in generated code, so
             saying only "source not available" invites reading it as a line
             in the file named beside it — which is where it points to nothing
             at all. And "no sourcemap covered this frame" is wrong when no map
             was looked at: it sends somebody hunting for a missing map that is
             sitting on disk, when the real answer is that this event came from
             a different build. -->
        <p v-else class="px-3 py-2 text-xs text-dimmed border-t border-default">
          <template v-if="group.frame.unresolved === 'no-map'">
            No sourcemap for this file was found, so
            <span class="font-mono">{{ group.frame.line }}</span>
            is a line in the built bundle. This usually means the error came
            from a different build than the one running now.
          </template>
          <template v-else-if="!group.frame.original">
            The sourcemap for this file covers no position here, so
            <span class="font-mono">{{ group.frame.line }}</span>
            is a line in the built bundle rather than in this file.
          </template>
          <template v-else>
            Mapped to this file, but its contents could not be read.
          </template>
        </p>
      </div>

      <!-- Library frames: one row, expandable when the path through a
           dependency actually matters. -->
      <div v-else>
        <button
          type="button"
          class="w-full flex items-center gap-2 px-3 py-1.5 text-left rounded-lg border border-dashed border-muted text-xs text-dimmed hover:text-muted hover:border-default cursor-pointer"
          @click="toggle(index)"
        >
          <UIcon
            :name="expanded.has(index) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-3.5"
          />
          {{ group.label }}
        </button>

        <div v-if="expanded.has(index)" class="mt-1 ps-4 space-y-0.5">
          <div
            v-for="(frame, n) in group.frames"
            :key="n"
            class="flex flex-wrap items-baseline gap-x-2 text-xs font-mono text-dimmed"
          >
            <span>{{ location(frame) }}</span>
            <span class="text-muted/60">{{ frameLabel(frame) }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>

  <pre
    v-else-if="raw"
    class="rounded-lg border border-default p-3 overflow-x-auto text-xs font-mono whitespace-pre-wrap text-toned"
  ><code>{{ raw }}</code></pre>

  <p v-else class="text-sm text-muted">
    No stack trace was captured.
  </p>
</template>
