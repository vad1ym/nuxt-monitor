<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MonitorFacetCounts, MonitorFacetFilter } from '../../lib/types'
import type { IssueDetail } from '../api'
import { api } from '../api'
import { formatCount } from '../chart'
import { absoluteTime, relativeTime } from '../format'
import { primaryFrame, shortLocation } from '../frames'
import IssueBreakdown from './IssueBreakdown.vue'
import StackTrace from './StackTrace.vue'
import TimeChart from './TimeChart.vue'

const props = defineProps<{ fingerprint: string }>()
const emit = defineEmits<{ back: [], changed: [] }>()

const detail = ref<IssueDetail | null>(null)
const error = ref('')
const loading = ref(false)
const selected = ref(0)

/** Narrows the breakdown and the occurrences below it to one slice. */
const filter = ref<MonitorFacetFilter>({})

/**
 * How many values each dropdown in the breakdown may show.
 *
 * Undefined leaves it to the server's default. Not reset when the filter
 * changes: someone who opened up a long list is still reading it.
 */
const facetLimit = ref<number | undefined>()

const FACET_PAGE = 20

/**
 * The same facets across all traffic.
 *
 * Fetched once and kept: without it a breakdown cannot tell a real skew from
 * the shape of the audience, and it does not change while an issue is open.
 */
const baseline = ref<MonitorFacetCounts | null>(null)

const current = computed(() => detail.value?.events[selected.value])

const isFiltered = computed(() => Object.keys(filter.value).length > 0)

/** Where to look first — shown in the header rather than left in the trace. */
const location = computed(() => shortLocation(primaryFrame(current.value?.frames ?? [])))

/**
 * Whether that location survived a sourcemap.
 *
 * Without a map the line counts lines in the built bundle, and `shortPath`
 * trims the bundle URL down to something that looks exactly like a source
 * path — so an unresolved frame reads as a confident, wrong answer. Say which
 * it is instead.
 */
const locationMapped = computed(() =>
  Boolean(primaryFrame(current.value?.frames ?? [])?.original),
)

/**
 * What tells this occurrence apart from its neighbours.
 *
 * Time alone did not: a run of occurrences seconds apart all render as
 * "5m ago", so the picker offered twenty identical labels. Browser, status and
 * time together are what actually vary, and the first two are also what makes
 * one occurrence worth opening over another.
 */
const occurrenceLabel = computed(() => {
  const event = current.value

  if (!event) {
    return ''
  }

  const status = typeof event.context?.statusCode === 'number' ? String(event.context.statusCode) : undefined

  return [event.facets?.browser, status, relativeTime(event.timestamp)].filter(Boolean).join(' · ')
})

/**
 * Request details are promoted out of the context list: route, method and
 * status answer "which call broke" before anything else does.
 */
const request = computed(() => {
  const context = current.value?.context ?? {}

  return {
    url: typeof context.url === 'string' ? context.url : undefined,
    method: typeof context.method === 'string' ? context.method : undefined,
    status: typeof context.statusCode === 'number' ? context.statusCode : undefined,
  }
})

/** Everything else, minus the fields shown above and the noisy ones. */
const contextEntries = computed(() => {
  const skip = new Set(['url', 'method', 'statusCode', 'headers', 'userAgent'])

  return Object.entries(current.value?.context ?? {})
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => ({
      key,
      value: typeof value === 'object' && value !== null
        ? JSON.stringify(value, null, 2)
        : String(value),
    }))
})

const headers = computed(() => {
  const raw = current.value?.context?.headers

  return raw && typeof raw === 'object' ? Object.entries(raw as Record<string, unknown>) : []
})

const trend = computed(() => detail.value?.trend)

const trendSeries = computed(() => [{
  name: 'occurrences',
  values: trend.value?.points.map(point => point.count) ?? [],
  color: detail.value?.issue.side === 'client' ? 'var(--ui-info)' : 'var(--ui-warning)',
}])

/**
 * Whether the chart covers the whole life of the issue.
 *
 * Occurrences are trimmed per issue, so a busy one keeps recent history rather
 * than all of it. Drawing that as though it were everything would put the
 * issue's beginning at whatever the oldest surviving row happens to be, and a
 * fault that has run for a week would read as one that started this morning.
 */
const trendPartial = computed(() =>
  Boolean(trend.value && !isFiltered.value && trend.value.stored < (detail.value?.issue.count ?? 0)),
)

/**
 * How often it happens, over the span it happened in.
 *
 * Measured from first to last occurrence rather than "per hour since it
 * started": an issue that fired 200 times in a minute and never again is not
 * happening three times an hour, and averaging it over the silence since would
 * say exactly that.
 */
const rate = computed(() => {
  const issue = detail.value?.issue

  if (!issue || issue.count < 2) {
    return undefined
  }

  const spanMs = issue.lastSeen - issue.firstSeen

  // Everything inside one instant is a burst, not a rate.
  if (spanMs < 60_000) {
    return undefined
  }

  const perHour = issue.count / (spanMs / 3_600_000)

  if (perHour >= 1) {
    return `${formatCount(Math.round(perHour))}/hour`
  }

  const perDay = perHour * 24

  return perDay >= 1 ? `${formatCount(Math.round(perDay))}/day` : 'less than once a day'
})

async function load({ keepSelection = false } = {}): Promise<void> {
  loading.value = true
  error.value = ''

  try {
    detail.value = await api.issue(props.fingerprint, filter.value, facetLimit.value)

    // The filter changes which occurrences exist, so an index into the old
    // list would point at the wrong one — or at nothing. Widening a facet
    // dropdown does not: the occurrences are the same ones, and resetting
    // would throw away the trace the reader is looking at.
    if (!keepSelection) {
      selected.value = 0
    }
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not load this issue'
  }
  finally {
    loading.value = false
  }
}

/** Another page of values in the breakdown's dropdowns. */
async function expandFacets(): Promise<void> {
  facetLimit.value = (facetLimit.value ?? FACET_PAGE) + FACET_PAGE
  await load({ keepSelection: true })
}

/**
 * What the audience looks like, for judging this issue's breakdown against.
 *
 * Taken from counted page views, not from the facets of other errors. Those
 * two were the same call until traffic facets existed, and the difference is
 * the whole point of the comparison: measured against other errors, "90% of
 * these are on Chrome" is confirmed by whichever browser is noisiest, and the
 * one-line summary restated the shape of the error table rather than saying
 * anything about this issue.
 *
 * Falls back to the error facets when no page views were counted — a fresh
 * install, or an API-only application. A weaker baseline is still better than
 * ranking slices by share alone, which has no notion of over-representation.
 */
async function loadBaseline(): Promise<void> {
  try {
    const answer = await api.facets(undefined, 24, undefined, true)
    const counted = Object.values(answer.traffic ?? {}).some(group => group.values.length > 0)

    baseline.value = counted ? answer.traffic! : answer.facets
  }
  catch {
    // Failure here costs the comparison, not the page.
    baseline.value = null
  }
}

async function toggleResolved(): Promise<void> {
  if (!detail.value) {
    return
  }

  detail.value.issue = await api.setResolved(props.fingerprint, !detail.value.issue.resolved)
  emit('changed')
}

async function toggleIgnored(): Promise<void> {
  if (!detail.value) {
    return
  }

  detail.value.issue = await api.setIgnored(props.fingerprint, !detail.value.issue.ignored)
  emit('changed')
}

watch(() => props.fingerprint, () => {
  // A filter from the previous issue rarely applies to the next one, and
  // landing on an empty issue looks like a missing issue. Assigning a fresh
  // object would also wake the filter watcher below and load twice, so the
  // reset only happens when there is something to reset.
  if (Object.keys(filter.value).length) {
    filter.value = {}
    return
  }

  void load()
}, { immediate: true })

// Wrapped rather than passed directly: a watcher hands its callback the new
// value, which would arrive as `load`'s options object and let a facet named
// `keepSelection` decide whether the selection resets.
watch(filter, () => void load(), { deep: true })

onMounted(loadBaseline)
</script>

<template>
  <div class="space-y-6">
    <UButton
      variant="link"
      color="neutral"
      size="sm"
      icon="i-lucide-arrow-left"
      label="All issues"
      class="ps-0"
      @click="emit('back')"
    />

    <div v-if="loading" class="space-y-3">
      <USkeleton class="h-8 w-72" />
      <USkeleton class="h-32 w-full" />
    </div>

    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      :title="error"
      icon="i-lucide-triangle-alert"
    />

    <template v-else-if="detail">
      <header class="space-y-3">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-xs">
              <UBadge
                :color="detail.issue.side === 'client' ? 'info' : 'warning'"
                variant="subtle"
                size="sm"
                :label="detail.issue.side"
              />
              <!-- A manual report's type is always `MonitorException`. What
                   the caller named — the group and the level — is the part
                   that carries information, so it takes the slot. -->
              <UBadge
                v-if="detail.issue.manual"
                color="primary"
                variant="subtle"
                size="sm"
                icon="i-lucide-flag"
                :label="detail.issue.group
                  ? `${detail.issue.group}${detail.issue.level ? ` · ${detail.issue.level}` : ''}`
                  : `reported${detail.issue.level ? ` · ${detail.issue.level}` : ''}`"
                title="Raised by exception(), not caught"
              />

              <span v-else class="font-medium text-muted">{{ detail.issue.type }}</span>
              <UBadge
                v-if="detail.issue.resolved"
                color="success"
                variant="subtle"
                size="sm"
                label="resolved"
              />
              <UBadge
                v-if="detail.issue.ignored"
                color="neutral"
                variant="subtle"
                size="sm"
                label="ignored"
              />
            </div>

            <h1 class="mt-1.5 font-mono text-lg leading-snug text-highlighted break-words">
              {{ detail.issue.message }}
            </h1>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <!-- Two different claims, so two buttons. "Resolve" says it was
                 fixed; "Ignore" says it is not ours to fix — an extension, a
                 bot, someone else's script. With only the first, the way to
                 quiet noise was to call it fixed, which makes the resolved
                 list a record of work that never happened. -->
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              :icon="detail.issue.ignored ? 'i-lucide-bell' : 'i-lucide-bell-off'"
              :label="detail.issue.ignored ? 'Unignore' : 'Ignore'"
              @click="toggleIgnored"
            />

            <UButton
              size="sm"
              :color="detail.issue.resolved ? 'neutral' : 'primary'"
              variant="subtle"
              :icon="detail.issue.resolved ? 'i-lucide-rotate-ccw' : 'i-lucide-check'"
              :label="detail.issue.resolved ? 'Reopen' : 'Resolve'"
              @click="toggleResolved"
            />
          </div>
        </div>

        <!-- The facts you want before reading any code. -->
        <dl class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div v-if="location">
            <dt class="text-xs text-dimmed">
              Where
            </dt>
            <dd class="font-mono" :class="locationMapped ? 'text-primary' : 'text-muted'">
              {{ location }}<span
                v-if="!locationMapped"
                class="ms-1.5 font-sans text-xs text-dimmed"
                title="No sourcemap covered this frame, so the line is a position in the built bundle"
              >· in bundle</span>
            </dd>
          </div>

          <div v-if="request.url">
            <dt class="text-xs text-dimmed">
              Request
            </dt>
            <dd class="font-mono text-toned">
              <span v-if="request.method" class="text-muted">{{ request.method }} </span>{{ request.url }}
              <span v-if="request.status" class="text-muted">→ {{ request.status }}</span>
            </dd>
          </div>

          <div>
            <dt class="text-xs text-dimmed">
              Occurrences
            </dt>
            <!-- Under a filter the total would contradict everything below it,
                 so it becomes "matching of total". -->
            <dd class="text-toned">
              <template v-if="isFiltered">{{ detail.eventCount }} of </template>{{ detail.issue.count }}
              <!-- The count alone cannot separate "200 times last Tuesday"
                   from "200 times a day, still going". -->
              <span v-if="rate" class="text-dimmed"> · {{ rate }}</span>
            </dd>
          </div>

          <div>
            <dt class="text-xs text-dimmed">
              Last seen
            </dt>
            <dd class="text-toned" :title="absoluteTime(detail.issue.lastSeen)">
              {{ relativeTime(detail.issue.lastSeen) }}
            </dd>
          </div>

          <div>
            <dt class="text-xs text-dimmed">
              First seen
            </dt>
            <dd class="text-toned" :title="absoluteTime(detail.issue.firstSeen)">
              {{ relativeTime(detail.issue.firstSeen) }}
            </dd>
          </div>
        </dl>
      </header>

      <!-- When it happened, not just how often. A count says an issue is
           frequent; the shape says whether it is over, steady, or starting. -->
      <section v-if="trend && trend.points.length > 1" class="rounded-lg border border-default p-3">
        <div class="mb-3 flex items-baseline justify-between gap-3">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Occurrences over time
          </h2>
          <!-- Said rather than left to be inferred: the chart is drawn from the
               occurrences that survived trimming, and without this the issue
               looks as though it began when the oldest kept one did. -->
          <span v-if="trendPartial" class="text-xs text-dimmed">
            last {{ formatCount(trend.stored) }} of {{ formatCount(detail.issue.count) }}
          </span>
        </div>

        <TimeChart :at="trend.points.map(point => point.at)" :series="trendSeries" />
      </section>

      <!-- The conclusion only. One line, and it frames the stack below it —
           the table it used to drag along now sits at the foot of the page. -->
      <IssueBreakdown
        v-model:filter="filter"
        finding-only
        :facets="detail.facets"
        :baseline="baseline"
        :session-count="detail.sessionCount"
        :event-count="detail.eventCount"
        :loading="loading"
      />

      <!-- The evidence behind the sentence at the top, and the control that
           narrows the occurrences above. One row of dropdowns rather than five
           stacked lists: as a column it ran to forty rows and pushed the stack
           — the reason anybody opened the issue — off the screen. -->
      <section>
        <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
          Narrow by
        </h2>

        <IssueBreakdown
          v-model:filter="filter"
          panel-only
          :facets="detail.facets"
          :baseline="baseline"
          :session-count="detail.sessionCount"
          :event-count="detail.eventCount"
          :loading="loading"
          @expand="expandFacets"
        />
      </section>

      <div v-if="!detail.events.length" class="py-10 text-center">
        <p class="text-sm text-muted">
          No occurrences match this filter.
        </p>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          label="Clear filters"
          class="mt-2"
          @click="filter = {}"
        />
      </div>

      <!-- Stepped through, not picked from a row of buttons.
           Twenty-two of them read "5m ago", eighteen identically: a control
           whose labels do not distinguish its options cannot be used to
           choose. The label now leads with what actually differs between
           occurrences, and the arrows carry the position. -->
      <div v-else-if="detail.events.length > 1" class="flex flex-wrap items-center gap-2">
        <UButtonGroup size="xs">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-left"
            aria-label="Previous occurrence"
            :disabled="selected === 0"
            @click="selected--"
          />
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-right"
            aria-label="Next occurrence"
            :disabled="selected >= detail.events.length - 1"
            @click="selected++"
          />
        </UButtonGroup>

        <span class="text-sm text-toned">
          <span class="tabular-nums">{{ selected + 1 }} of {{ detail.events.length }}</span>
          <span v-if="occurrenceLabel" class="text-dimmed"> · {{ occurrenceLabel }}</span>
        </span>

        <UButton
          v-if="selected !== 0"
          size="xs"
          color="neutral"
          variant="ghost"
          label="Latest"
          class="ms-auto"
          @click="selected = 0"
        />
      </div>

      <template v-if="current">
        <section>
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
            Stack
          </h2>
          <StackTrace :frames="current.frames" :raw="current.stack" />
        </section>

        <section v-if="current.breadcrumbs?.length">
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
            Leading up to it
          </h2>
          <ol class="space-y-0.5">
            <li
              v-for="(crumb, index) in current.breadcrumbs"
              :key="index"
              class="flex items-baseline gap-3 rounded px-2 py-1 text-sm hover:bg-elevated/30"
            >
              <span class="w-16 shrink-0 text-xs uppercase text-dimmed">{{ crumb.type }}</span>
              <span class="min-w-0 flex-1 text-toned break-all">{{ crumb.message }}</span>
              <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(crumb.timestamp) }}</span>
            </li>
          </ol>
        </section>

        <section v-if="contextEntries.length">
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
            Context
          </h2>
          <dl class="grid grid-cols-[minmax(5rem,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm">
            <template v-for="entry in contextEntries" :key="entry.key">
              <dt class="font-mono text-dimmed">
                {{ entry.key }}
              </dt>
              <dd class="font-mono break-words whitespace-pre-wrap text-toned">
                {{ entry.value }}
              </dd>
            </template>
          </dl>
        </section>

        <!-- Collapsed: useful when you need it, noise when you do not. -->
        <UCollapsible v-if="headers.length">
          <UButton
            variant="ghost"
            color="neutral"
            size="sm"
            class="ps-0"
            trailing-icon="i-lucide-chevron-down"
            :label="`Request headers (${headers.length})`"
          />

          <template #content>
            <dl class="mt-2 grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-4 gap-y-1 text-xs">
              <template v-for="[key, value] in headers" :key="key">
                <dt class="font-mono text-dimmed">
                  {{ key }}
                </dt>
                <dd class="font-mono break-all text-muted">
                  {{ value }}
                </dd>
              </template>
            </dl>
          </template>
        </UCollapsible>

        <div v-if="current.tags?.length" class="flex flex-wrap gap-1.5">
          <UBadge
            v-for="tag in current.tags"
            :key="tag"
            color="neutral"
            variant="outline"
            size="sm"
            :label="tag"
          />
        </div>
      </template>
    </template>
  </div>
</template>
