import type { MonitorFacetFilter, MonitorFacetName } from '../lib/types'

/**
 * The dashboard's state, expressed as a URL.
 *
 * It used to live in refs alone, which quietly cost three things people expect
 * of a tool like this: a link to an issue could not be pasted to whoever owns
 * the code, a reload dropped you back on the overview, and the browser's back
 * button left the dashboard rather than undoing the last step. The hash is
 * used, not the path, because the dashboard mounts at a configurable route and
 * is served by one catch-all handler — a real path would have to be recognised
 * by the server, and it is not.
 */

export type View = 'overview' | 'issues' | 'traffic' | 'stats' | 'notifications'

const VIEWS: View[] = ['overview', 'issues', 'traffic', 'stats', 'notifications']

/** Facets a URL may carry. Anything else in the query string is ignored. */
const FACETS: MonitorFacetName[] = [
  'browser',
  'browserVersion',
  'os',
  'osVersion',
  'deviceType',
  'release',
  'route',
]

export interface RouteState {
  view: View
  /** Fingerprint of the open issue, when one is. */
  issue: string | null
  scope: string
  search: string
  filter: MonitorFacetFilter
  hours: number
  /** `last-seen` | `count` | `first-seen` — see `SORTS` in `App.vue`. */
  sort: string
}

const DEFAULTS: RouteState = {
  view: 'overview',
  issue: null,
  scope: 'open',
  search: '',
  filter: {},
  hours: 24,
  sort: 'last-seen',
}

/**
 * Parses the current hash.
 *
 * Anything unrecognised falls back to the default rather than throwing: a
 * hand-edited or truncated URL should open the dashboard, not break it.
 */
export function readRoute(hash = window.location.hash): RouteState {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?')
  const segments = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query)

  const [head, tail] = segments
  const view = VIEWS.includes(head as View) ? head as View : DEFAULTS.view

  const filter: MonitorFacetFilter = {}

  for (const name of FACETS) {
    const values = params.getAll(name)

    if (values.length) {
      filter[name] = values
    }
  }

  const hours = Number(params.get('window'))

  return {
    view,
    // `#/issues/<fingerprint>` opens one; `#/issues` is the list.
    issue: view === 'issues' && tail ? decodeURIComponent(tail) : null,
    scope: params.get('scope') ?? DEFAULTS.scope,
    search: params.get('q') ?? DEFAULTS.search,
    filter,
    hours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULTS.hours,
    sort: params.get('sort') ?? DEFAULTS.sort,
  }
}

/**
 * Builds the hash for a state.
 *
 * Only what differs from the default is written, so the common case stays a
 * short, readable address instead of one carrying six redundant parameters.
 */
export function writeRoute(state: RouteState): string {
  const path = state.issue
    ? `issues/${encodeURIComponent(state.issue)}`
    : state.view

  const params = new URLSearchParams()

  // Scope only qualifies the issue list, and only when it is not the default.
  if (state.view === 'issues' && !state.issue && state.scope !== DEFAULTS.scope) {
    params.set('scope', state.scope)
  }

  if (state.search) {
    params.set('q', state.search)
  }

  for (const name of FACETS) {
    for (const value of state.filter[name] ?? []) {
      params.append(name, value)
    }
  }

  if (state.hours !== DEFAULTS.hours) {
    params.set('window', String(state.hours))
  }

  if (state.sort !== DEFAULTS.sort) {
    params.set('sort', state.sort)
  }

  const query = params.toString()

  return `#/${path}${query ? `?${query}` : ''}`
}
