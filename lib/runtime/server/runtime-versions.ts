/**
 * What the application was running on, as one line.
 *
 * The first question asked of a bug report from somebody else's machine, and
 * the last thing anybody remembers to write down. A stack through
 * `@vue/runtime-core` means something different on Nuxt 4.0 than on 4.5, and
 * "works on mine" is usually a version difference nobody has looked up yet.
 *
 * One string rather than three fields: "Node 24.2.0 · Nuxt 4.5.2" is read as a
 * single fact — the environment — and three rows of version numbers would push
 * the fields somebody actually came for off the first screen.
 */

export interface BuiltVersions {
  nuxt?: string
  nitro?: string
}

export function describeRuntime(versions: BuiltVersions | undefined): string | undefined {
  const parts = [
    // The process actually executing, read here rather than stamped at build
    // time — a bundle built on one Node major and deployed onto another is a
    // real and common cause of a real bug, and a build-time value would hide
    // exactly that case by reporting the version that did not run.
    //
    // `v24.2.0` → `Node 24.2.0`: the leading v is noise beside a word.
    typeof process?.version === 'string' ? `Node ${process.version.replace(/^v/, '')}` : undefined,
    versions?.nuxt ? `Nuxt ${versions.nuxt}` : undefined,
    versions?.nitro ? `Nitro ${versions.nitro}` : undefined,
  ].filter(Boolean)

  // Undefined rather than an empty string, so the caller leaves the field out
  // entirely instead of storing a blank row on every event.
  return parts.length ? parts.join(' · ') : undefined
}
