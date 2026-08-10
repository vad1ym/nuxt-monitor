import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Copies the runtime into `dist` as TypeScript source.
 *
 * These files import `#imports` and rely on Nuxt's auto-imports, which resolve
 * only inside a Nuxt build. `tsc` cannot compile them here, and it does not
 * need to — Nitro and Vite compile them in the consuming app, which is also
 * what gives the consumer sourcemaps into our runtime.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'lib', 'runtime')
const dest = join(root, 'dist', 'runtime')

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
await cp(src, dest, { recursive: true })

// Tests are not part of the published runtime.
await removeTests(dest)

console.log('[monitor] runtime copied to dist/runtime')

async function removeTests(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      await removeTests(full)
    }
    else if (entry.name.endsWith('.test.ts')) {
      await rm(full)
    }
  }
}
