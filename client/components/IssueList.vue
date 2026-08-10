<script setup lang="ts">
import type { MonitorIssue } from '../../lib/types'
import { relativeTime } from '../format'

/**
 * The list is scanned, not read.
 *
 * So each row leads with the one thing that identifies the fault — the message
 * — and puts the location under it. Type, route and status are supporting
 * detail and are styled as such; without that hierarchy every row looks the
 * same and there is nothing to aim at.
 */
defineProps<{ issues: MonitorIssue[], loading: boolean }>()

const emit = defineEmits<{ select: [fingerprint: string] }>()

/** Server errors read as 5xx-or-not; 4xx is usually someone else's problem. */
function statusColor(status: number): 'error' | 'warning' | 'neutral' {
  if (status >= 500) {
    return 'error'
  }

  return status >= 400 ? 'warning' : 'neutral'
}
</script>

<template>
  <div v-if="loading && !issues.length" class="space-y-2">
    <USkeleton v-for="n in 5" :key="n" class="h-16 w-full" />
  </div>

  <div v-else-if="!issues.length" class="py-20 text-center">
    <UIcon name="i-lucide-check-circle-2" class="size-8 text-dimmed mx-auto" />
    <p class="mt-3 text-sm text-muted">
      Nothing here.
    </p>
    <p class="text-xs text-dimmed">
      Errors appear as soon as they happen — there is nothing to configure.
    </p>
  </div>

  <ul v-else class="divide-y divide-default border-y border-default">
    <li v-for="issue in issues" :key="issue.fingerprint">
      <button
        type="button"
        class="group w-full flex items-start gap-3 px-3 py-3 text-left hover:bg-elevated/40 transition-colors cursor-pointer"
        @click="emit('select', issue.fingerprint)"
      >
        <!-- A single dot carries side and state, so the row does not open with
             two competing badges. -->
        <span
          class="mt-1.5 size-2 shrink-0 rounded-full"
          :class="issue.resolved
            ? 'bg-success/60'
            : issue.side === 'client' ? 'bg-info' : 'bg-warning'"
          :title="`${issue.side}${issue.resolved ? ', resolved' : ''}`"
        />

        <div class="min-w-0 flex-1">
          <!-- The message first: it is what a person recognises. -->
          <p class="text-sm text-highlighted truncate">
            {{ issue.message }}
          </p>

          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dimmed">
            <span class="font-medium text-muted">{{ issue.type }}</span>

            <template v-if="issue.culprit">
              <span aria-hidden="true">·</span>
              <span class="font-mono text-primary/90">{{ issue.culprit }}</span>
            </template>

            <template v-if="issue.route">
              <span aria-hidden="true">·</span>
              <span class="font-mono truncate max-w-[16rem]">
                <span v-if="issue.method" class="text-muted">{{ issue.method }} </span>{{ issue.route }}
              </span>
            </template>

            <UBadge
              v-if="issue.status"
              :color="statusColor(issue.status)"
              variant="subtle"
              size="sm"
              :label="String(issue.status)"
            />
          </div>
        </div>

        <div class="shrink-0 text-right">
          <div class="text-sm font-medium tabular-nums" :title="`${issue.count} occurrences`">
            {{ issue.count }}
          </div>
          <div class="text-xs text-dimmed whitespace-nowrap">
            {{ relativeTime(issue.lastSeen) }}
          </div>
        </div>
      </button>
    </li>
  </ul>
</template>
