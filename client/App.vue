<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MonitorFacetCounts, MonitorFacetFilter, MonitorIssue } from '../lib/types'
import { ApiError, api } from './api'
import type { View } from './route'
import { readRoute, writeRoute } from './route'
import HealthBanner from './components/HealthBanner.vue'
import IssueDetail from './components/IssueDetail.vue'
import IssueFilters from './components/IssueFilters.vue'
import IssueList from './components/IssueList.vue'
import LoginView from './components/LoginView.vue'
import MonitorLogo from './components/MonitorLogo.vue'
import NotificationsView from './components/NotificationsView.vue'
import OverviewView from './components/OverviewView.vue'
import RoutesView from './components/RoutesView.vue'

/**
 * Three screens, not six.
 *
 * Releases, Environments, Routes and Sessions were four `GROUP BY` clauses over
 * the same events, presented as four destinations. On real data they held one,
 * five, eleven and three rows — three clicks for three sparse tables and no
 * conclusion. What each was actually for now lives where the question is asked:
 * environments are the filters above the issue list, sessions and the latest
 * deploy are figures on the overview, and routes — the only one of the four
 * with a denominator of its own — keeps a screen under Traffic.
 */

interface Scope { side?: string, resolved?: boolean, ignored?: boolean, manual?: boolean }

const SCOPES: Record<string, { label: string, icon: string, value: Scope }> = {
  'open': { label: 'Open', icon: 'i-lucide-inbox', value: { resolved: false } },
  'server': { label: 'Server', icon: 'i-lucide-server', value: { side: 'server' } },
  'client': { label: 'Client', icon: 'i-lucide-monitor', value: { side: 'client' } },
  // Reports raised by `exception()`. Beside the sides rather than at the end:
  // "what did we decide to watch" is a question asked as often as "what broke
  // on the server", and a list that mixes the two hides the smaller set.
  'manual': { label: 'Reported', icon: 'i-lucide-flag', value: { manual: true } },
  'resolved': { label: 'Resolved', icon: 'i-lucide-check', value: { resolved: true } },
  'all': { label: 'All', icon: 'i-lucide-list', value: {} },
  // Ignored issues are excluded from every other scope, so the only way back
  // to one is a scope of its own.
  'ignored': { label: 'Ignored', icon: 'i-lucide-bell-off', value: { ignored: true } },
}

/**
 * What "worst" means, named on screen.
 *
 * The order was fixed and unlabelled, so the list could not say whether it was
 * showing the newest or the most frequent — and those are different questions
 * asked on different days.
 */
const SORTS: Record<string, string> = {
  'last-seen': 'Recent',
  'count': 'Frequent',
  'first-seen': 'New',
}

const NAV: { view: View, label: string, icon: string }[] = [
  { view: 'overview', label: 'Overview', icon: 'i-lucide-layout-dashboard' },
  { view: 'issues', label: 'Issues', icon: 'i-lucide-inbox' },
  { view: 'traffic', label: 'Traffic', icon: 'i-lucide-route' },
  // Last, and deliberately not beside the screens that answer "what broke":
  // this one answers "who was told", which is a question asked once at setup
  // and then only when something did not arrive.
  { view: 'notifications', label: 'Notifications', icon: 'i-lucide-bell' },
]

/**
 * One window, shared by every screen.
 *
 * Each screen used to own a `ref(24)`, so switching Routes to 7d and returning
 * to the overview silently compared a week against a day. Releases had no
 * switch at all while still showing "last seen".
 */
const WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
]

const authenticated = ref<boolean | null>(null)
const issues = ref<MonitorIssue[]>([])
const total = ref(0)
const loading = ref(false)
const facets = ref<MonitorFacetCounts | null>(null)

/**
 * How many values each facet dropdown may show.
 *
 * Undefined means "whatever the server defaults to". Raised a page at a time
 * by the filter bar, and deliberately *not* reset when the filter or window
 * changes: someone who opened up the route list is still reading it, and
 * snapping it shut under them because a sibling filter moved would undo a
 * choice they made on purpose.
 */
const facetLimit = ref<number | undefined>()

const FACET_PAGE = 20

/**
 * Screen state, read from the address bar.
 *
 * It lived in plain refs, which made the dashboard un-linkable: the fix for an
 * error could not be discussed by pasting a URL, a reload dropped you back on
 * the overview, and the browser's back button left the tool entirely. Every
 * value below is in the hash, so the address is the state.
 */
const route = readRoute()

const view = ref<View>(route.view)
const selected = ref<string | null>(route.issue)
const scope = ref(route.scope)
const search = ref(route.search)
const filter = ref<MonitorFacetFilter>(route.filter)
const hours = ref(route.hours)
const sort = ref(route.sort)

/** How many rows are on screen. Grows by a page; never shrinks silently. */
const PAGE = 50
const shown = ref(PAGE)

const query = computed(() => ({
  ...(SCOPES[scope.value]?.value ?? {}),
  sort: sort.value,
  search: search.value.trim() || undefined,
  limit: shown.value,
}))

/**
 * When this dashboard was last looked at.
 *
 * An issue first seen since then is marked new, which is the difference
 * between a list that looks identical every morning and one that says three
 * things appeared overnight. Stored per browser: it describes this reader's
 * attention, not a fact about the application, so it has no business in the
 * database — and a second person's visit must not clear the first's marks.
 */
const SEEN_KEY = 'nuxt-monitor:last-seen'

const lastSeen = ref(Number(localStorage.getItem(SEEN_KEY)) || 0)

/** Not written until the reader leaves, or every issue would clear on sight. */
function rememberVisit(): void {
  localStorage.setItem(SEEN_KEY, String(Date.now()))
}

const hasMore = computed(() => issues.value.length < total.value)

/** Whether anything narrows the list — decides which empty screen to show. */
const narrowed = computed(() =>
  Boolean(search.value.trim())
  || Object.keys(filter.value).length > 0
  || scope.value !== 'open',
)

/**
 * Whether the module has ever recorded anything.
 *
 * An empty list means something different on a fresh install than on an
 * application whose issues have all been dealt with, and neither should read
 * like a failure. Taken from the health endpoint's all-time count, which is
 * not subject to the window or the filters.
 */
const everCollected = ref(false)

/** The issues screen owns the search field and the filter bar. */
const onIssues = computed(() => view.value === 'issues')

async function refresh(): Promise<void> {
  loading.value = true

  try {
    // The list and the filter counts are fetched together so the counts always
    // describe the list beside them.
    const [result, counts] = await Promise.all([
      api.issues(query.value, filter.value),
      api.facets(filter.value, undefined, facetLimit.value),
    ])

    issues.value = result.issues
    total.value = result.total
    facets.value = counts.facets

    // Only worth asking while the list is empty: that is the one moment the
    // answer changes what is on screen.
    if (!result.total && !everCollected.value) {
      everCollected.value = Boolean((await api.health().catch(() => null))?.issues)
    }
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

/**
 * Shows another page of facet values.
 *
 * Grows the limit rather than paging: the dropdown is a ranked list read from
 * the top, and a second page that replaced the first would hide the values the
 * reader was comparing against.
 */
async function expandFacets(): Promise<void> {
  facetLimit.value = (facetLimit.value ?? FACET_PAGE) + FACET_PAGE
  await refresh()
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

/** Everything that could be hiding the rows, undone at once. */
function clearNarrowing(): void {
  search.value = ''
  filter.value = {}
  scope.value = 'open'
}

/** Typing should not fire a request per keystroke. */
let debounce: ReturnType<typeof setTimeout> | undefined

watch([query, filter], () => {
  clearTimeout(debounce)
  debounce = setTimeout(refresh, 200)
}, { deep: true })

// A narrower list starts from the top: keeping page four of the previous
// question would show an empty screen that looks like "no results".
watch([scope, search, filter, sort], () => {
  shown.value = PAGE
}, { deep: true })

/**
 * State out to the address bar.
 *
 * `replaceState` while typing, `pushState` otherwise: a search field that
 * pushed a history entry per keystroke would make the back button useless for
 * everything else.
 */
let applyingRoute = false

watch([view, selected, scope, search, filter, hours, sort], ([, , , next], [, , , previous]) => {
  if (applyingRoute) {
    return
  }

  const hash = writeRoute({
    view: view.value,
    issue: selected.value,
    scope: scope.value,
    search: search.value,
    filter: filter.value,
    hours: hours.value,
    sort: sort.value,
  })

  if (hash === window.location.hash) {
    return
  }

  const typing = next !== previous

  window.history[typing ? 'replaceState' : 'pushState'](null, '', hash)
}, { deep: true })

/** And back in, when the browser moves through history. */
function applyRoute(): void {
  const next = readRoute()

  applyingRoute = true

  view.value = next.view
  selected.value = next.issue
  scope.value = next.scope
  search.value = next.search
  filter.value = next.filter
  hours.value = next.hours
  sort.value = next.sort

  // Released after the watchers above have seen the assignments, so restoring
  // a state does not immediately write it back as a new history entry.
  void Promise.resolve().then(() => {
    applyingRoute = false
  })
}

onMounted(() => window.addEventListener('hashchange', applyRoute))
onUnmounted(() => window.removeEventListener('hashchange', applyRoute))

// On the way out, not on arrival: stamping the visit at mount would clear the
// marks in the same frame that drew them.
onMounted(() => window.addEventListener('pagehide', rememberVisit))
onUnmounted(() => {
  window.removeEventListener('pagehide', rememberVisit)
  rememberVisit()
})

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
          <MonitorLogo class="h-6 w-auto" />
          <!-- The package name in full, with the prefix carrying the brand
               colour: `monitor` alone does not name what this is. -->
          <span class="font-semibold"><span class="text-primary">nuxt-</span>monitor</span>
        </div>

        <!-- Three destinations, flat. The four that used to sit under
             "Insights" were four groupings of one dataset, not four places. -->
        <nav class="flex-1 p-2 space-y-1 overflow-y-auto">
          <UButton
            v-for="item in NAV"
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
          class="sticky top-0 z-10 h-14 border-b border-default bg-default/80 backdrop-blur"
        >
          <div class="flex h-full max-w-7xl items-center gap-3 px-5">
            <UInput
              v-if="onIssues"
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

            <!-- One window for the whole dashboard, so two screens can never
                 quietly describe two different spans of time. -->
            <!-- Spaced rather than a UButtonGroup: the group exists to weld
                 buttons into one control, and the seam made the selected one
                 read as part of its neighbour instead of standing apart. -->
            <!-- Hidden on Notifications: nothing there is windowed, and a
                 control that changes nothing is worse than no control — it
                 invites the reader to conclude the log respects it. -->
            <div v-if="view !== 'notifications'" class="ms-auto flex items-center gap-1.5">
              <UButton
                v-for="option in WINDOWS"
                :key="option.hours"
                size="xs"
                :color="hours === option.hours ? 'primary' : 'neutral'"
                :variant="hours === option.hours ? 'subtle' : 'outline'"
                :label="option.label"
                @click="hours = option.hours"
              />
            </div>

            <span v-if="onIssues" class="text-xs text-dimmed whitespace-nowrap">
              {{ total }} {{ total === 1 ? 'issue' : 'issues' }}
            </span>
          </div>
        </header>

        <main class="flex-1 p-5">
          <!-- Left-aligned, not centred: the sidebar already anchors the eye
               to the left, and centring the column pulled the content away
               from it on a wide screen. The width cap stays — long message
               lines are hard to read edge to edge. -->
          <!-- The overview is tiles and charts, which a reading-width column
               starves; the issue screens are prose-shaped and keep the cap. -->
          <div :class="view === 'overview' ? 'max-w-7xl' : 'max-w-5xl'">
            <!-- Above every screen, not on one of its own: a collector that
                 stopped recording makes every other number on the page a lie,
                 so it cannot be somewhere you have to think to look. -->
            <HealthBanner />

            <OverviewView
              v-if="view === 'overview'"
              :hours="hours"
              @select="openIssue"
              @browse="showIssues"
            />

            <RoutesView v-else-if="view === 'traffic'" :hours="hours" />

            <NotificationsView v-else-if="view === 'notifications'" />

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
                v-model:sort="sort"
                :facets="facets"
                :scopes="SCOPES"
                :sorts="SORTS"
                class="mb-4"
                @expand="expandFacets"
              />

              <IssueList
                :issues="issues"
                :loading="loading"
                :new-since="lastSeen"
                :narrowed="narrowed"
                :collected="everCollected"
                @select="selected = $event"
                @clear="clearNarrowing"
              />

              <!-- Paged rather than capped: the list stopped at fifty with
                   nothing on screen saying so, which reads as "that is all of
                   them" when it is not. -->
              <div v-if="hasMore" class="mt-4 flex items-center justify-center gap-3">
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :loading="loading"
                  :label="`Show ${Math.min(PAGE, total - issues.length)} more`"
                  @click="shown += PAGE"
                />
                <span class="text-xs text-dimmed tabular-nums">
                  {{ issues.length }} of {{ total }}
                </span>
              </div>
            </template>
          </div>
        </main>
      </div>
    </div>
  </UApp>
</template>
