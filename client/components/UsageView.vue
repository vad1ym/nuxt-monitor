<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MonitorInteraction } from '../../lib/types'
import { api } from '../api'
import { formatCount, formatShare } from '../chart'

/**
 * What the application is used for.
 *
 * Every other screen here starts from something going wrong. This one starts
 * from what people do when nothing does, because that is the question behind
 * "what should we cover with a test": the page carrying a third of the traffic
 * whose main button everybody presses is worth a test long before the one that
 * merely threw an error last week.
 *
 * Two panes rather than one list, because neither number means much alone. A
 * page ranking says where people are; a press ranking says what they do there.
 * Read together they separate the two cases that look identical in a list of
 * routes — a busy page whose primary action is rarely triggered, and one where
 * every visitor triggers it — and those want different tests.
 *
 * Selecting a page narrows the right-hand pane to it. That is the whole
 * interaction: pick a page from the ranking, see what is pressed on it.
 */
const props = defineProps<{ hours: number }>()

const pages = ref<{ value: string, count: number, share: number }[]>([])
const presses = ref<MonitorInteraction[]>([])
const selected = ref<string | null>(null)
const loading = ref(false)
const pressLoading = ref(false)
const failed = ref<string | null>(null)

/**
 * Page views, read from the traffic baseline.
 *
 * The same facet the filter panel offers, asked for as a baseline rather than
 * as a breakdown of errors: this pane is about traffic, and counting only the
 * page views that produced an error would rank the pages that break rather
 * than the ones that are used.
 */
async function loadPages(): Promise<void> {
  loading.value = true
  failed.value = null

  try {
    const response = await api.facets(undefined, props.hours, 50, true)

    pages.value = response.traffic?.route?.values ?? []

    // A selection that no longer exists in the window would leave the right
    // pane describing a page absent from the left one.
    if (selected.value && !pages.value.some(page => page.value === selected.value)) {
      selected.value = null
    }
  }
  catch (error) {
    failed.value = error instanceof Error ? error.message : 'Could not load page views.'
  }
  finally {
    loading.value = false
  }
}

async function loadPresses(): Promise<void> {
  pressLoading.value = true

  try {
    const response = await api.interactions(props.hours, selected.value ?? undefined, 30)

    presses.value = response.interactions
  }
  catch {
    // The page ranking is still worth showing on its own, so a failure here
    // empties one pane rather than blanking the screen.
    presses.value = []
  }
  finally {
    pressLoading.value = false
  }
}

watch(() => props.hours, () => {
  void loadPages()
  void loadPresses()
}, { immediate: true })

watch(selected, () => void loadPresses())

/** The busiest page, which is what every other row is read against. */
const busiest = computed(() => pages.value[0]?.count ?? 0)

const totalViews = computed(() => pages.value.reduce((sum, page) => sum + page.count, 0))
const totalPresses = computed(() => presses.value.reduce((sum, row) => sum + row.count, 0))
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="text-sm font-semibold text-highlighted">
        Usage
      </h2>
      <p class="text-xs text-dimmed">
        Which pages carry the traffic, and what is pressed on them — the two
        numbers that say where a test is worth writing.
      </p>
    </div>

    <p v-if="failed" class="rounded-md bg-elevated/60 px-3 py-2 text-xs text-toned">
      {{ failed }}
    </p>

    <div class="grid gap-4 lg:grid-cols-2">
      <!-- Pages -->
      <section class="rounded-lg border border-default p-3 flex flex-col min-h-0">
        <header class="mb-2 flex items-baseline gap-2">
          <h3 class="text-xs font-medium text-toned">
            Pages
          </h3>
          <span class="text-xs text-dimmed tabular-nums">
            {{ formatCount(totalViews) }} views
          </span>
          <UButton
            v-if="selected"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            label="All pages"
            class="ms-auto"
            @click="selected = null"
          />
        </header>

        <p v-if="loading && !pages.length" class="text-xs text-dimmed">
          Loading…
        </p>

        <!-- Absent and empty are different things, and the difference matters
             here more than usual: no page views at all means the module is not
             seeing traffic, which is a setup problem rather than a quiet week. -->
        <p v-else-if="!pages.length" class="text-xs text-dimmed">
          No page views recorded in this window.
        </p>

        <ul v-else class="min-h-0 flex-1 space-y-px overflow-y-auto pe-1">
          <li v-for="page in pages" :key="page.value">
            <button
              type="button"
              class="relative w-full flex items-center gap-2 overflow-hidden rounded px-1.5 py-1 text-left text-xs transition-colors cursor-pointer"
              :class="page.value === selected ? 'text-highlighted' : 'text-toned hover:bg-elevated/40'"
              :aria-pressed="page.value === selected"
              @click="selected = page.value === selected ? null : page.value"
            >
              <!-- Scaled against the busiest page rather than the total, so
                   the shape of the column stays readable when one page has
                   most of the traffic and the rest would otherwise be slivers. -->
              <span
                class="absolute inset-y-0 start-0 rounded"
                :class="page.value === selected ? 'bg-primary/25' : 'bg-elevated/60'"
                :style="{ width: `${Math.max(busiest ? (page.count / busiest) * 100 : 0, 1.5)}%` }"
              />

              <UIcon
                v-if="page.value === selected"
                name="i-lucide-check"
                class="relative size-3 shrink-0 text-primary"
              />

              <span class="relative min-w-0 flex-1 truncate font-mono">{{ page.value }}</span>
              <span class="relative shrink-0 tabular-nums text-dimmed">{{ formatShare(page.share) }}</span>
              <span class="relative w-10 shrink-0 text-end tabular-nums text-muted">{{ formatCount(page.count) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <!-- Presses -->
      <section class="rounded-lg border border-default p-3 flex flex-col min-h-0">
        <header class="mb-2 flex items-baseline gap-2">
          <h3 class="text-xs font-medium text-toned">
            Pressed
          </h3>
          <span class="min-w-0 truncate text-xs text-dimmed">
            <template v-if="selected">on <span class="font-mono">{{ selected }}</span></template>
            <template v-else>across every page</template>
          </span>
          <span class="ms-auto shrink-0 text-xs text-dimmed tabular-nums">
            {{ formatCount(totalPresses) }}
          </span>
        </header>

        <p v-if="pressLoading && !presses.length" class="text-xs text-dimmed">
          Loading…
        </p>

        <!-- Said plainly, because an empty pane beside a busy page ranking is
             itself a finding: people are on the page and pressing nothing the
             collector recognises. -->
        <p v-else-if="!presses.length" class="text-xs text-dimmed">
          <template v-if="selected">
            Nothing pressed on this page in this window.
          </template>
          <template v-else>
            No presses recorded yet. Buttons and links are counted once someone
            uses them.
          </template>
        </p>

        <ul v-else class="min-h-0 flex-1 space-y-px overflow-y-auto pe-1">
          <li v-for="row in presses" :key="`${row.route}\n${row.label}`">
            <div class="relative w-full flex items-center gap-2 overflow-hidden rounded px-1.5 py-1 text-xs">
              <span
                class="absolute inset-y-0 start-0 rounded bg-elevated/60"
                :style="{ width: `${Math.max(row.share * 100, 1.5)}%` }"
              />

              <span class="relative min-w-0 flex-1 truncate text-toned">{{ row.label }}</span>

              <!-- The route travels with the row when the pane is showing
                   every page: the same label on two pages is two different
                   actions, and without this they read as one. -->
              <span
                v-if="!selected"
                class="relative min-w-0 max-w-[40%] shrink-0 truncate font-mono text-dimmed"
              >{{ row.route }}</span>

              <span class="relative shrink-0 tabular-nums text-dimmed">{{ formatShare(row.share) }}</span>
              <span class="relative w-10 shrink-0 text-end tabular-nums text-muted">{{ formatCount(row.count) }}</span>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
