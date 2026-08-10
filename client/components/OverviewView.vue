<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MonitorOverview } from '../../lib/types'
import { api } from '../api'
import { formatCount, formatRate } from '../chart'
import { relativeTime } from '../format'
import ErrorChart from './ErrorChart.vue'

const emit = defineEmits<{ select: [fingerprint: string], browse: [scope: string] }>()

const WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
]

const data = ref<MonitorOverview | null>(null)
const loading = ref(true)
const hours = ref(24)

/**
 * The headline rate answers "how bad is this", which raw counts cannot: ten
 * failures out of ten requests and ten out of a million are different
 * situations.
 */
const rate = computed(() => formatRate(data.value?.errorRate))

async function load(): Promise<void> {
  loading.value = true

  try {
    data.value = await api.overview(hours.value)
  }
  finally {
    loading.value = false
  }
}

watch(hours, load)
onMounted(load)

defineExpose({ refresh: load })
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-lg font-semibold">
        Overview
      </h1>

      <div class="flex gap-0.5">
        <UButton
          v-for="window in WINDOWS"
          :key="window.hours"
          size="xs"
          :color="hours === window.hours ? 'primary' : 'neutral'"
          :variant="hours === window.hours ? 'subtle' : 'ghost'"
          :label="window.label"
          @click="hours = window.hours"
        />
      </div>
    </div>

    <div v-if="loading && !data" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <USkeleton v-for="n in 4" :key="n" class="h-20" />
    </div>

    <template v-else-if="data">
      <!-- Four numbers, each answering a different question. -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="rounded-lg border border-default p-3">
          <p class="text-xs text-dimmed">
            Error rate
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums"
             :class="(data.errorRate ?? 0) > 0.05 ? 'text-error' : 'text-highlighted'">
            {{ rate }}
          </p>
          <p class="text-xs text-dimmed">
            <template v-if="data.requestCount">
              {{ formatCount(data.failedRequestCount) }} of {{ formatCount(data.requestCount) }} requests
            </template>
            <template v-else>
              no requests counted yet
            </template>
          </p>
        </div>

        <button
          type="button"
          class="rounded-lg border border-default p-3 text-left hover:border-warning cursor-pointer"
          @click="emit('browse', 'server')"
        >
          <p class="text-xs text-dimmed">
            Server errors
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums text-warning">
            {{ formatCount(data.serverErrors) }}
          </p>
          <p class="text-xs text-dimmed">
            events
          </p>
        </button>

        <button
          type="button"
          class="rounded-lg border border-default p-3 text-left hover:border-info cursor-pointer"
          @click="emit('browse', 'client')"
        >
          <p class="text-xs text-dimmed">
            Client errors
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums text-info">
            {{ formatCount(data.clientErrors) }}
          </p>
          <p class="text-xs text-dimmed">
            events
          </p>
        </button>

        <button
          type="button"
          class="rounded-lg border border-default p-3 text-left hover:border-primary cursor-pointer"
          @click="emit('browse', 'open')"
        >
          <p class="text-xs text-dimmed">
            Open issues
          </p>
          <p class="mt-1 text-2xl font-semibold tabular-nums text-highlighted">
            {{ formatCount(data.unresolvedCount) }}
          </p>
          <p class="text-xs text-dimmed">
            of {{ formatCount(data.issueCount) }} distinct
          </p>
        </button>
      </div>

      <section class="rounded-lg border border-default p-3">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Errors over time
          </h2>
          <div class="flex items-center gap-3 text-xs text-dimmed">
            <span class="flex items-center gap-1.5">
              <span class="size-2 rounded-sm bg-warning" />server
            </span>
            <span class="flex items-center gap-1.5">
              <span class="size-2 rounded-sm bg-info" />client
            </span>
          </div>
        </div>

        <ErrorChart :trend="data.trend" :window-ms="data.windowMs" />
      </section>

      <!-- The single biggest contributor, called out: in most incidents one
           fault accounts for most of the noise. -->
      <section v-if="data.topIssue" class="rounded-lg border border-warning/40 bg-warning/5 p-3">
        <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
          Biggest contributor
        </h2>

        <button
          type="button"
          class="mt-2 w-full text-left cursor-pointer"
          @click="emit('select', data.topIssue.issue.fingerprint)"
        >
          <p class="text-sm text-highlighted">
            {{ data.topIssue.issue.message }}
          </p>
          <p class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-dimmed">
            <span class="font-medium text-muted">{{ data.topIssue.issue.type }}</span>
            <span v-if="data.topIssue.issue.culprit" aria-hidden="true">·</span>
            <span v-if="data.topIssue.issue.culprit" class="font-mono text-primary/90">
              {{ data.topIssue.issue.culprit }}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {{ data.topIssue.issue.count }} events,
              <strong class="text-muted">{{ formatRate(data.topIssue.share) }}</strong> of all errors
            </span>
          </p>
        </button>
      </section>

      <div class="grid lg:grid-cols-2 gap-4">
        <section>
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
            Most recent
          </h2>

          <ul v-if="data.recent.length" class="divide-y divide-default border-y border-default">
            <li v-for="issue in data.recent" :key="issue.fingerprint">
              <button
                type="button"
                class="w-full flex items-center gap-2.5 px-2 py-2 text-left hover:bg-elevated/40 cursor-pointer"
                @click="emit('select', issue.fingerprint)"
              >
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  :class="issue.side === 'client' ? 'bg-info' : 'bg-warning'"
                />
                <span class="min-w-0 flex-1">
                  <span class="block text-sm text-highlighted truncate">{{ issue.message }}</span>
                  <span v-if="issue.culprit" class="block text-xs font-mono text-dimmed truncate">
                    {{ issue.culprit }}
                  </span>
                </span>
                <span class="shrink-0 text-xs text-dimmed">{{ relativeTime(issue.lastSeen) }}</span>
              </button>
            </li>
          </ul>

          <p v-else class="py-6 text-center text-sm text-dimmed">
            Nothing in this window.
          </p>
        </section>

        <section>
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">
            Routes by failure rate
          </h2>

          <ul v-if="data.topRoutes.length" class="divide-y divide-default border-y border-default">
            <li
              v-for="route in data.topRoutes"
              :key="route.route"
              class="flex items-center gap-3 px-2 py-2"
            >
              <span class="min-w-0 flex-1 font-mono text-sm text-toned truncate">
                {{ route.route }}
              </span>
              <span class="shrink-0 text-xs text-dimmed tabular-nums">
                {{ formatCount(route.failed) }} / {{ formatCount(route.total) }}
              </span>
              <span
                class="shrink-0 w-12 text-right text-sm font-medium tabular-nums"
                :class="route.rate > 0.05 ? 'text-error' : 'text-muted'"
              >
                {{ formatRate(route.rate) }}
              </span>
            </li>
          </ul>

          <p v-else class="py-6 text-center text-sm text-dimmed">
            No failing routes.
          </p>
        </section>
      </div>
    </template>
  </div>
</template>
