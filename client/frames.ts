import type { MonitorFrame } from '../lib/types'
import { isNoiseFrame } from '../lib/runtime/shared/vendor-frame'

/**
 * Presentation logic for a stack trace.
 *
 * A raw trace is mostly framework internals: the one frame that belongs to the
 * application is buried among a dozen identical-looking `runtime-core` lines.
 * Grouping runs of library frames into a single collapsed row is what makes
 * the app frame findable at a glance.
 */

export interface AppFrameGroup {
  kind: 'app'
  frame: MonitorFrame
  /** Index in the original trace, so ordering survives grouping. */
  index: number
}

export interface VendorFrameGroup {
  kind: 'vendor'
  frames: MonitorFrame[]
  /** "7 frames in vue" — what the collapsed row says. */
  label: string
}

export type FrameGroup = AppFrameGroup | VendorFrameGroup

/**
 * Whether a frame belongs to a dependency rather than the application.
 *
 * A resolved frame is judged on where it resolved *to*, and only that. The
 * bundle it came from is nobody's code: a server error resolving to
 * `server/middleware/fail.ts` arrives on a frame whose raw path is
 * `.nuxt/dev/index.mjs`, and letting that decide hid the user's own file —
 * with its snippet already loaded — inside a collapsed "build output" group.
 *
 * Only when resolution failed does the raw path get a say, because then it is
 * the only evidence there is.
 */
export function isVendorFrame(frame: MonitorFrame): boolean {
  const resolved = frame.original?.file

  if (resolved) {
    // Vite's dev maps name their sources as a bare filename —
    // `runtime-core.esm-bundler.js`, with no `node_modules/` in front — so a
    // resolved vendor frame can look like application code. Where the bare
    // name settles nothing, the URL it arrived on still says plainly what it
    // is.
    return isNoiseFrame(resolved) || (!resolved.includes('/') && isNoiseFrame(frame.file))
  }

  return isNoiseFrame(frame.file)
}

/** Collapses consecutive library frames, keeping application frames apart. */
export function groupFrames(frames: MonitorFrame[]): FrameGroup[] {
  const groups: FrameGroup[] = []

  for (const [index, frame] of frames.entries()) {
    if (!isVendorFrame(frame)) {
      groups.push({ kind: 'app', frame, index })
      continue
    }

    const last = groups.at(-1)

    if (last?.kind === 'vendor') {
      last.frames.push(frame)
      last.label = vendorLabel(last.frames)
      continue
    }

    groups.push({ kind: 'vendor', frames: [frame], label: vendorLabel([frame]) })
  }

  return groups
}

/** Names the packages a run of library frames came from. */
function vendorLabel(frames: MonitorFrame[]): string {
  const packages = new Set<string>()

  for (const frame of frames) {
    // The resolved path first, then the raw one. Vite's dev maps name their
    // sources as a bare filename, which carries no package — but the URL the
    // frame arrived on still spells out `node_modules/@vue/runtime-core`, and
    // a group labelled "6 frames" says less than one naming what they are.
    const name = packageOf(frame.original?.file ?? frame.file) ?? packageOf(frame.file)

    if (name) {
      packages.add(name)
    }
  }

  const count = `${frames.length} ${frames.length === 1 ? 'frame' : 'frames'}`
  const names = [...packages].slice(0, 2)

  if (names.length === 0) {
    return count
  }

  const suffix = packages.size > names.length ? ` +${packages.size - names.length}` : ''

  return `${count} in ${names.join(', ')}${suffix}`
}

/**
 * The package a file belongs to, for labelling only.
 *
 * Exported for the issue header, which has to name the dependency a trace
 * stopped in: "in ofetch" is what turns an unopenable path into an
 * explanation of why it is unopenable.
 */
export function packageOf(file: string): string | undefined {
  if (file.startsWith('node:')) {
    return 'node'
  }

  // pnpm stores packages as `.pnpm/@scope+name@version/node_modules/@scope/name`,
  // so read the real name from the inner directory rather than the mangled
  // outer one — otherwise the label says `@vue+runtime-core@3.5.41`.
  const pnpm = /node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/.exec(file)

  if (pnpm?.[1]) {
    return pnpm[1]
  }

  const match = /node_modules\/(@[^/]+\/[^/@]+|[^/@]+)/.exec(file)

  if (match?.[1]) {
    return match[1]
  }

  if (/[/\\]\.output[/\\]|[/\\]\.nuxt[/\\]/.test(file)) {
    return 'build output'
  }

  return undefined
}

/**
 * The frame a reader should look at first.
 *
 * Almost always the topmost application frame; a trace made entirely of
 * library frames falls back to the top of the stack.
 */
export function primaryFrame(frames: MonitorFrame[]): MonitorFrame | undefined {
  return frames.find(frame => !isVendorFrame(frame)) ?? frames[0]
}

/**
 * A short, readable location for a frame.
 *
 * Absolute build paths carry no information a reader can act on, so they are
 * trimmed back to the part that identifies the file.
 */
export function shortLocation(frame: MonitorFrame | undefined): string | undefined {
  if (!frame) {
    return undefined
  }

  const file = frame.original?.file ?? frame.file
  const line = frame.original?.line ?? frame.line

  return `${shortPath(file)}:${line}`
}

/** Trims a path down to the part worth reading. */
export function shortPath(file: string): string {
  const cleaned = file
    .replace(/^[\w-]+:\/\/[^/]*/, '')
    .replace(/\?.*$/, '')

  const inPackage = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(.+)$/.exec(cleaned)

  if (inPackage?.[1]) {
    return inPackage[1]
  }

  // Anchor at the app directory when the path reaches into the source tree.
  const inApp = /(?:^|\/)((?:app|src|server|pages|components|composables|layouts|middleware|utils)\/.+)$/
    .exec(cleaned)

  if (inApp?.[1]) {
    return inApp[1]
  }

  // Otherwise keep the last two segments: enough to identify, short enough to read.
  const segments = cleaned.replace(/^\.+\//, '').split('/').filter(Boolean)

  return segments.slice(-2).join('/') || cleaned
}
