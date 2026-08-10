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
const props = defineProps<{
  issues: MonitorIssue[]
  loading: boolean
  /**
   * When this reader last had the dashboard open.
   *
   * Anything first seen after it is marked. Without the mark, a list that
   * gained three new faults overnight looks exactly like one that gained
   * none — the counts move, but nothing says which rows are the new ones.
   */
  newSince?: number
  /** Whether a search, scope or facet is narrowing the list right now. */
  narrowed?: boolean
  /** Whether the module has ever recorded anything at all. */
  collected?: boolean
}>()

const emit = defineEmits<{ select: [fingerprint: string], clear: [] }>()

/** Never on a first visit: with nothing to compare against, everything is new. */
function isNew(issue: MonitorIssue): boolean {
  return Boolean(props.newSince) && issue.firstSeen > props.newSince!
}

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

  <!-- Three empty screens, not one. "Nothing here" was shown when a filter
       matched nothing, when everything was fixed, and when the module had
       never recorded anything — three situations that call for three
       different next moves, rendered identically. -->
  <div v-else-if="!issues.length" class="py-20 text-center">
    <template v-if="narrowed">
      <UIcon name="i-lucide-filter-x" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        No issue matches this.
      </p>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        label="Clear filters"
        class="mt-2"
        @click="emit('clear')"
      />
    </template>

    <template v-else-if="collected">
      <UIcon name="i-lucide-check-circle-2" class="size-8 text-success/70 mx-auto" />
      <p class="mt-3 text-sm text-muted">
        Nothing open.
      </p>
      <p class="text-xs text-dimmed">
        Every issue recorded so far has been resolved or ignored.
      </p>
    </template>

    <!-- The first-run case. Silence from a monitoring tool is ambiguous by
         nature, so say which kind of silence this is. -->
    <template v-else>
      <UIcon name="i-lucide-radar" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        Collecting — no errors yet.
      </p>
      <p class="text-xs text-dimmed">
        Both sides are watched already; nothing to configure. The first error
        appears here within a second of being thrown.
      </p>
    </template>
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
          <p class="flex items-center gap-2 text-sm text-highlighted">
            <span class="truncate">{{ issue.message }}</span>

            <UBadge
              v-if="isNew(issue)"
              color="primary"
              variant="subtle"
              size="sm"
              label="new"
              class="shrink-0"
              title="First seen since you last looked"
            />
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
