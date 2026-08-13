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

/**
 * The colour a manual report's level earns.
 *
 * `critical` and `error` share `error`: the distinction between them matters
 * for alert routing, where it decides who gets woken, and not in a list where
 * both mean "look at this". Two shades of red would be a difference the eye
 * has to decode for no decision it changes here.
 */
function levelColor(level: MonitorIssue['level']): 'error' | 'warning' | 'info' | 'neutral' {
  if (level === 'critical' || level === 'error') {
    return 'error'
  }

  if (level === 'warning') {
    return 'warning'
  }

  return level === 'info' ? 'info' : 'neutral'
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
            : issue.manual ? 'bg-primary' : issue.side === 'client' ? 'bg-info' : 'bg-warning'"
          :title="`${issue.manual ? 'reported' : issue.side}${issue.resolved ? ', resolved' : ''}`"
        />

        <div class="min-w-0 flex-1">
          <!-- The message first: it is what a person recognises. Truncated at
               whatever width is left rather than at a fixed 200px — the badges
               that used to follow it now sit at the right-hand end, so there
               is nothing for a long message to push off the row. -->
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
            <!-- The request, as one thing: method, route and the status it
                 ended with. Which of those is an endpoint and which a page is
                 legible from the path itself, so a separate api/page badge was
                 a label for something already on screen — and the status used
                 to sit at the far end of the row, three items away from the
                 route it belonged to. -->
            <UBadge
              v-if="issue.route"
              :color="issue.status ? statusColor(issue.status) : 'neutral'"
              variant="subtle"
              size="sm"
              class="max-w-[22rem] shrink-0"
            >
              <!-- Spelled out rather than relying on whitespace inside the
                   template: Vue trims text between tags, so `GET ` collapsed
                   and the method ran straight into the path. -->
              <span class="truncate font-mono">
                <span v-if="issue.method" class="opacity-70">{{ `${issue.method} ` }}</span>{{ issue.route }}<span
                  v-if="issue.status"
                >{{ ` → ${issue.status}` }}</span>
              </span>
            </UBadge>

            <!-- The file, where there is one worth opening. Skipped for an
                 endpoint: the route is what somebody goes and looks at, and a
                 compiled path beside it is two locations for one fault. -->
            <span
              v-if="issue.culprit && issue.kind !== 'api'"
              class="font-mono text-primary/90"
            >{{ issue.culprit }}</span>
          </div>
        </div>

        <!-- The group sits at the right rather than after the message: the
             title is truncated, so a badge trailing it landed at a different
             distance on every row and the column of labels was unscannable.
             Here it lines up, next to the numbers the eye already goes to.

             Shown for every issue that has one, not only for manual reports.
             A group assigned by a config rule is the same fact as one named at
             an `exception()` call — "this failure is about payments" — and
             showing it for one and not the other made the whole dimension look
             like a property of manual reporting. The filter offered `catalog`
             and `admin`; the list never said which rows were in them. -->
        <UBadge
          v-if="issue.group || issue.manual"
          :color="issue.manual ? levelColor(issue.level) : 'neutral'"
          variant="subtle"
          size="sm"
          :icon="issue.manual ? 'i-lucide-flag' : 'i-lucide-tag'"
          class="mt-0.5 shrink-0"
          :label="issue.group || 'reported'"
          :title="issue.manual
            ? `Reported by exception()${issue.level ? `, ${issue.level}` : ''}`
            : `In the ${issue.group} group`"
        />

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
