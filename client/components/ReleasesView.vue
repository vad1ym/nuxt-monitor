<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { MonitorRelease } from '../../lib/types'
import { api } from '../api'
import { formatCount } from '../chart'
import { relativeTime } from '../format'

const emit = defineEmits<{ browse: [release: string] }>()
/**
 * Releases, and what each one introduced.
 *
 * The column that matters is "new" — issues whose first occurrence anywhere
 * carries that release. A total error count mostly measures how much traffic a
 * release served; the new count measures the deploy. A release that ran for a
 * week will out-number yesterday's on every other column while having caused
 * nothing.
 */
const releases = ref<MonitorRelease[]>([])
const loading = ref(true)
const error = ref('')

/** Bars are relative to the busiest release, so the shape is comparable. */
const peak = computed(() =>
  Math.max(1, ...releases.value.map(release => release.events)),
)

/** The newest release that actually introduced something. */
const regression = computed(() =>
  releases.value.find(release => release.newIssues > 0 && release.release !== 'unknown'),
)

async function load(): Promise<void> {
  loading.value = true

  try {
    releases.value = (await api.stats('releases')).releases ?? []
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not load releases'
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-5">
    <header>
      <h1 class="text-lg font-semibold text-highlighted">
        Releases
      </h1>
      <p class="text-sm text-dimmed">
        What each deploy introduced, not just what happened while it ran.
      </p>
    </header>

    <div v-if="loading" class="space-y-2">
      <USkeleton v-for="n in 4" :key="n" class="h-12 w-full" />
    </div>

    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      :title="error"
      icon="i-lucide-triangle-alert"
    />

    <div v-else-if="!releases.length" class="py-16 text-center">
      <UIcon name="i-lucide-tag" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        No releases recorded yet.
      </p>
      <p class="text-xs text-dimmed">
        Set <code class="font-mono">monitor.release</code>, or let it read your CI's commit SHA.
      </p>
    </div>

    <template v-else>
      <!-- The conclusion first, when there is one. -->
      <div
        v-if="regression"
        class="flex items-start gap-2.5 rounded-lg border border-default bg-elevated/40 px-3 py-2.5"
      >
        <UIcon name="i-lucide-git-commit-horizontal" class="mt-0.5 size-4 shrink-0 text-primary" />
        <p class="text-sm text-toned">
          <strong class="font-semibold text-highlighted">
            {{ regression.newIssues }}
            {{ regression.newIssues === 1 ? 'issue' : 'issues' }} first appeared in
            {{ regression.release }}
          </strong>
          <span class="text-dimmed">
            · {{ formatCount(regression.events) }} events · last seen
            {{ relativeTime(regression.lastSeen) }}
          </span>
        </p>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs uppercase tracking-wide text-dimmed">
              <th class="pb-2 text-start font-medium">Release</th>
              <th class="pb-2 text-end font-medium">New</th>
              <th class="pb-2 text-end font-medium">Issues</th>
              <th class="pb-2 text-end font-medium">Events</th>
              <th class="pb-2 text-end font-medium">Sessions</th>
              <th class="pb-2 text-end font-medium whitespace-nowrap">Last seen</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-default">
            <tr
              v-for="release in releases"
              :key="release.release"
              class="group cursor-pointer hover:bg-elevated/40 transition-colors"
              @click="emit('browse', release.release)"
            >
              <td class="relative py-2 pe-4">
                <span
                  class="absolute inset-y-0 start-0 -z-10 rounded bg-elevated/50"
                  :style="{ width: `${(release.events / peak) * 100}%` }"
                />
                <span class="font-mono text-highlighted">{{ release.release }}</span>
              </td>

              <td class="py-2 text-end tabular-nums">
                <!-- Emphasised only when non-zero: a release that introduced
                     nothing should not draw the eye. -->
                <span
                  v-if="release.newIssues"
                  class="font-medium text-warning"
                >+{{ release.newIssues }}</span>
                <span v-else class="text-dimmed">—</span>
              </td>

              <td class="py-2 text-end tabular-nums text-toned">{{ release.issues }}</td>
              <td class="py-2 text-end tabular-nums text-toned">{{ formatCount(release.events) }}</td>
              <td class="py-2 text-end tabular-nums text-toned">
                {{ release.sessions ? formatCount(release.sessions) : '—' }}
              </td>
              <td class="py-2 text-end text-xs text-dimmed whitespace-nowrap">
                {{ relativeTime(release.lastSeen) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
