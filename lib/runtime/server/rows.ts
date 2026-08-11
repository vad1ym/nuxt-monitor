import type { MonitorFacets, MonitorFrame, MonitorIssue, MonitorSide } from '../../types'
import { isVendorFrame } from '../shared/vendor-frame'

/**
 * Turning database rows into the shapes the API returns.
 *
 * Pure functions with no access to a connection, kept apart from the store so
 * that "what a row means" can be read and tested without a database.
 */

export function toFacets(row: Record<string, unknown>): MonitorFacets | undefined {
  const facets: MonitorFacets = {
    session: (row.session as string | null) ?? undefined,
    browser: (row.browser as string | null) ?? undefined,
    browserVersion: (row.browser_version as string | null) ?? undefined,
    os: (row.os as string | null) ?? undefined,
    osVersion: (row.os_version as string | null) ?? undefined,
    deviceType: (row.device_type as string | null) ?? undefined,
    release: (row.release as string | null) ?? undefined,
  }

  // Events written before the facet columns existed carry none of this, and an
  // object of undefineds is noise in the API response.
  return Object.values(facets).some(value => value !== undefined) ? facets : undefined
}

export function toIssue(row: Record<string, unknown>): MonitorIssue {
  return {
    fingerprint: row.fingerprint as string,
    type: row.type as string,
    message: row.message as string,
    side: row.side as MonitorSide,
    count: Number(row.count),
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
    resolved: Number(row.resolved) === 1,
    ignored: Number(row.ignored) === 1,
    culprit: (row.culprit as string | null) ?? undefined,
    route: (row.route as string | null) ?? undefined,
    method: (row.method as string | null) ?? undefined,
    status: row.status === null || row.status === undefined ? undefined : Number(row.status),
  }
}

/**
 * The frame worth naming in a list row.
 *
 * Taken from the raw stack rather than a resolved one: resolution is lazy and
 * happens when an issue is opened, but the list needs something to show now.
 * Library frames are skipped for the same reason they are collapsed in the
 * trace view — they say nothing about where the bug is.
 */
export function culpritOf(stack: string | undefined): string | undefined {
  if (!stack) {
    return undefined
  }

  for (const line of stack.split('\n').slice(1)) {
    const trimmed = line.trim()

    if (!trimmed.startsWith('at ') && !trimmed.includes('@')) {
      continue
    }

    // Framework frames name the machinery, not the fault. `createError` throws
    // from inside Nitro's own bundle, so without skipping these every such
    // error would be blamed on `nitro.mjs` and the list would say the same
    // useless thing about all of them.
    if (isVendorFrame(trimmed)) {
      continue
    }

    // "at fn (/path/file.ts:12:5)" or "fn@/path/file.ts:12:5"
    const match = /[(@\s]([^\s()]+):(\d+):\d+\)?$/.exec(trimmed)

    if (match?.[1]) {
      const file = match[1].replace(/^[\w-]+:\/\/[^/]*/, '').split('/').slice(-2).join('/')

      return `${file}:${match[2]}`
    }
  }

  return undefined
}

/**
 * The same name, taken from frames a sourcemap has already resolved.
 *
 * `culpritOf` reads the built file, because at capture time that is all there
 * is: resolution needs the maps parsed, and doing that on the request path
 * would turn an error storm into a burst of map parsing. The cost is that the
 * list names `api/throw.mjs:15` — a file the author never wrote and cannot
 * open — where the fault is at `server/api/throw.ts:5`.
 *
 * So the name is corrected on the one occasion the frames are resolved anyway,
 * when somebody opens the issue. Nothing extra is parsed.
 *
 * Frames are searched in order and the first resolved application frame wins,
 * which is the same rule `culpritOf` applies: the deepest frame that belongs to
 * the application rather than to the machinery under it.
 *
 * The whole project-relative path is kept, where `culpritOf` keeps the last two
 * segments. That is not an inconsistency: a built path is absolute and mostly
 * machine (`/var/www/releases/17/.output/server/chunks/api/throw.mjs`), so two
 * segments is the part worth reading, while a resolved source is already the
 * short path the author knows — `server/api/throw.ts`. Cutting that to two
 * would drop the directory that separates `server/api` from `app/pages`.
 */
export function culpritOfFrames(frames: MonitorFrame[]): string | undefined {
  for (const frame of frames) {
    // An unresolved frame is skipped rather than used: falling back to its
    // built path here would overwrite a stored name with the same guess, and
    // a later frame may still resolve.
    if (!frame.original) {
      continue
    }

    const { file, line } = frame.original
    const clean = file
      // `webpack://app/…` and friends: a protocol prefix reads as a directory.
      .replace(/^[\w-]+:\/\/[^/]*/, '')
      // Sources sit relative to the map, which lives several directories deep
      // inside the build output, so they climb back out first. The `../` run
      // describes where the bundle was written, not where the code lives.
      .replace(/^(?:\.\.?\/)+/, '')
      .replace(/^\//, '')

    if (isVendorFrame(clean)) {
      continue
    }

    return `${clean}:${line}`
  }

  return undefined
}

/**
 * Escapes LIKE wildcards in a search term.
 *
 * Without this, searching for `100%` matches every row, and a `_` matches any
 * character — surprising behaviour from a plain search box.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

export function parseJson<T>(value: string | null): T | undefined {
  if (!value) {
    return undefined
  }

  try {
    return JSON.parse(value) as T
  }
  catch {
    return undefined
  }
}
