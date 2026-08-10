<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MonitorFacetCounts, MonitorFacetFilter, MonitorFacetName, MonitorIssue } from '../lib/types'
import { ApiError, api } from './api'
import EnvironmentsView from './components/EnvironmentsView.vue'
import HealthBanner from './components/HealthBanner.vue'
import IssueDetail from './components/IssueDetail.vue'
import IssueFilters from './components/IssueFilters.vue'
import IssueList from './components/IssueList.vue'
import LoginView from './components/LoginView.vue'
import OverviewView from './components/OverviewView.vue'
import ReleasesView from './components/ReleasesView.vue'
import RoutesView from './components/RoutesView.vue'
import SessionsView from './components/SessionsView.vue'

/**
 * The sidebar is navigation, not a control panel.
 *
 * Filters used to live there, which put a thing that changes the list beside
 * things that change the screen — and left no room for anything else. They now
 * sit above the list they act on, and the sidebar carries sections instead.
 */
type View = 'overview' | 'issues' | 'releases' | 'environments' | 'routes' | 'sessions'

interface Scope { side?: string, resolved?: boolean }

const SCOPES: Record<string, { label: string, icon: string, value: Scope }> = {
  'open': { label: 'Open', icon: 'i-lucide-inbox', value: { resolved: false } },
  'server': { label: 'Server', icon: 'i-lucide-server', value: { side: 'server' } },
  'client': { label: 'Client', icon: 'i-lucide-monitor', value: { side: 'client' } },
  'resolved': { label: 'Resolved', icon: 'i-lucide-check', value: { resolved: true } },
  'all': { label: 'All', icon: 'i-lucide-list', value: {} },
}

const SECTIONS: { view: View, label: string, icon: string }[] = [
  { view: 'releases', label: 'Releases', icon: 'i-lucide-tag' },
  { view: 'environments', label: 'Environments', icon: 'i-lucide-monitor-smartphone' },
  { view: 'routes', label: 'Routes', icon: 'i-lucide-route' },
  { view: 'sessions', label: 'Sessions', icon: 'i-lucide-users' },
]

const authenticated = ref<boolean | null>(null)
const view = ref<View>('overview')
const issues = ref<MonitorIssue[]>([])
const total = ref(0)
const loading = ref(false)
const selected = ref<string | null>(null)
const scope = ref('open')
const search = ref('')
const filter = ref<MonitorFacetFilter>({})
const facets = ref<MonitorFacetCounts | null>(null)

const query = computed(() => ({
  ...(SCOPES[scope.value]?.value ?? {}),
  search: search.value.trim() || undefined,
}))

/** The issues screen owns the search field and the filter bar. */
const onIssues = computed(() => view.value === 'issues')

async function refresh(): Promise<void> {
  loading.value = true

  try {
    // The list and the filter counts are fetched together so the counts always
    // describe the list beside them.
    const [result, counts] = await Promise.all([
      api.issues(query.value, filter.value),
      api.facets(filter.value),
    ])

    issues.value = result.issues
    total.value = result.total
    facets.value = counts.facets
  }
  catch (caught) {
    // An expired session should return to the login screen rather than
    // leaving a dead page behind.
    if (caught instanceof ApiError && caught.status === 401) {
      authenticated.value = false
    }
  }
  finally {
    loading.value = false
  }
}

async function onAuthenticated(): Promise<void> {
  authenticated.value = true
  await refresh()
}

async function logout(): Promise<void> {
  await api.logout()
  authenticated.value = false
  selected.value = null
}

/** Opening an issue from the overview switches to the issues view with it. */
function openIssue(fingerprint: string): void {
  view.value = 'issues'
  selected.value = fingerprint
}

/** Sidebar entries and the overview's stat tiles both land here. */
function showIssues(next: string): void {
  view.value = 'issues'
  scope.value = next
  selected.value = null
}

function show(next: View): void {
  view.value = next
  selected.value = null
}

/**
 * Sections hand off to the issue list with a filter already applied.
 *
 * That is what makes them more than dashboards: clicking a release or a
 * browser is the same question as "show me those", and answering it anywhere
 * else would mean rebuilding the list twice.
 */
function browseBy(facet: MonitorFacetName, value: string): void {
  filter.value = { [facet]: [value] }
  scope.value = 'all'
  selected.value = null
  view.value = 'issues'
}

/** Typing should not fire a request per keystroke. */
let debounce: ReturnType<typeof setTimeout> | undefined

watch([query, filter], () => {
  clearTimeout(debounce)
  debounce = setTimeout(refresh, 200)
}, { deep: true })

onMounted(async () => {
  try {
    const { authenticated: ok } = await api.session()

    authenticated.value = ok

    if (ok) {
      await refresh()
    }
  }
  catch {
    authenticated.value = false
  }
})
</script>

<template>
  <UApp>
    <LoginView v-if="authenticated === false" @authenticated="onAuthenticated" />

    <div v-else-if="authenticated" class="min-h-screen flex">
      <aside class="w-52 shrink-0 border-e border-default flex flex-col">
        <div class="flex items-center gap-2 px-4 h-14 border-b border-default">
          <UIcon name="i-lucide-radar" class="size-5 text-primary" />
          <span class="font-semibold">monitor</span>
        </div>

        <nav class="flex-1 p-2 space-y-4 overflow-y-auto">
          <div>
            <UButton
              block
              size="sm"
              :color="view === 'overview' ? 'primary' : 'neutral'"
              :variant="view === 'overview' ? 'subtle' : 'ghost'"
              icon="i-lucide-layout-dashboard"
              label="Overview"
              class="justify-start"
              @click="show('overview')"
            />
          </div>

          <div>
            <!-- One entry, not five. Open/Server/Client/Resolved were filters
                 wearing navigation's clothes: they answer "which of these
                 issues", which belongs with the list, not in a menu that
                 chooses the screen. -->
            <UButton
              block
              size="sm"
              :color="onIssues ? 'primary' : 'neutral'"
              :variant="onIssues ? 'subtle' : 'ghost'"
              icon="i-lucide-inbox"
              label="Issues"
              class="justify-start"
              @click="showIssues(scope)"
            />
          </div>

          <div>
            <p class="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-dimmed">
              Insights
            </p>

            <UButton
              v-for="item in SECTIONS"
              :key="item.view"
              block
              size="sm"
              :color="view === item.view ? 'primary' : 'neutral'"
              :variant="view === item.view ? 'subtle' : 'ghost'"
              :icon="item.icon"
              :label="item.label"
              class="justify-start"
              @click="show(item.view)"
            />
          </div>
        </nav>

        <div class="p-2 border-t border-default">
          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-log-out"
            label="Sign out"
            class="justify-start"
            @click="logout"
          />
        </div>
      </aside>

      <div class="flex-1 min-w-0 flex flex-col">
        <!-- The bar spans the viewport so it can stick, but its contents share
             the column the list below is centred in — otherwise the search
             field sits at the far left while the issues start halfway across. -->
        <header
          v-if="onIssues"
          class="sticky top-0 z-10 h-14 border-b border-default bg-default/80 backdrop-blur"
        >
          <div class="flex h-full max-w-5xl items-center gap-3 px-5">
            <UInput
              v-model="search"
              icon="i-lucide-search"
              size="sm"
              placeholder="Search message, file or route…"
              class="w-full max-w-md"
            >
              <template v-if="search" #trailing>
                <UButton
                  color="neutral"
                  variant="link"
                  size="sm"
                  icon="i-lucide-x"
                  aria-label="Clear search"
                  @click="search = ''"
                />
              </template>
            </UInput>

            <span class="ms-auto text-xs text-dimmed whitespace-nowrap">
              {{ total }} {{ total === 1 ? 'issue' : 'issues' }}
            </span>
          </div>
        </header>

        <main class="flex-1 p-5">
          <!-- Left-aligned, not centred: the sidebar already anchors the eye
               to the left, and centring the column pulled the content away
               from it on a wide screen. The width cap stays — long message
               lines are hard to read edge to edge. -->
          <div class="max-w-5xl">
            <!-- Above every screen, not on one of its own: a collector that
                 stopped recording makes every other number on the page a lie,
                 so it cannot be somewhere you have to think to look. -->
            <HealthBanner />

            <OverviewView
              v-if="view === 'overview'"
              @select="openIssue"
              @browse="showIssues"
            />

            <ReleasesView
              v-else-if="view === 'releases'"
              @browse="browseBy('release', $event)"
            />

            <EnvironmentsView
              v-else-if="view === 'environments'"
              @browse="browseBy"
            />

            <RoutesView v-else-if="view === 'routes'" />

            <SessionsView v-else-if="view === 'sessions'" />

            <IssueDetail
              v-else-if="selected"
              :fingerprint="selected"
              @back="selected = null"
              @changed="refresh"
            />

            <template v-else>
              <!-- Filters sit above the list they act on, not in the sidebar
                   beside the things that change the screen. -->
              <IssueFilters
                v-model="filter"
                v-model:scope="scope"
                :facets="facets"
                :scopes="SCOPES"
                class="mb-4"
              />

              <IssueList
                :issues="issues"
                :loading="loading"
                @select="selected = $event"
              />
            </template>
          </div>
        </main>
      </div>
    </div>
  </UApp>
</template>
