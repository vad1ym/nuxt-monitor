import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Compiles the runtime into `dist` as JavaScript.
 *
 * The runtime cannot go through `tsc` because it imports `#imports`, which only
 * exists inside a Nuxt build. Shipping it as TypeScript source instead is what
 * `rollup-plugin-inject` and Nitro's own rollup pass choke on: a runtime under
 * `node_modules` is treated as an external dependency, so nothing applies a
 * TypeScript loader before rollup parses it, and `import type { … }` is not
 * valid JavaScript.
 *
 * esbuild solves both halves. It strips the types, and `#imports` stays an
 * unresolved import specifier that Nuxt fills in at the destination.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'lib', 'runtime')
const dest = join(root, 'dist', 'runtime')

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

const entryPoints = await collectSources(src)

await build({
  entryPoints,
  outdir: dest,
  outbase: src,
  // Each file is transpiled in place rather than bundled. The runtime's own
  // module graph has to survive into `dist` intact: Nuxt registers individual
  // files as plugins and route handlers, so they must stay individually
  // addressable.
  bundle: false,
  format: 'esm',
  platform: 'neutral',
  target: 'node22',
  sourcemap: true,
  // Embeds the TypeScript in the sourcemap itself. The `.ts` files are
  // deliberately not shipped next to the output — their presence under
  // `node_modules` is what broke the consuming build in the first place — so
  // this is what keeps a consumer's stack traces landing on readable source.
  sourcesContent: true,
})

// With `bundle: false` esbuild never resolves an import, so it emits every
// specifier exactly as written — and the sources omit extensions, which
// `tsc`'s bundler resolution allows but Node's ESM resolver does not.
await addExtensions(dest)

console.log(`[monitor] runtime compiled to dist/runtime (${entryPoints.length} files)`)

/** Collects every runtime source, minus the tests, which are not published. */
async function collectSources(dir) {
  const found = []

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      found.push(...await collectSources(full))
    }
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full)
    }
  }

  return found
}

/**
 * Appends `.js` to every extensionless relative import in the output.
 *
 * Only specifiers starting with `.` are touched; `#imports` and bare package
 * names are left for the consuming build to resolve. Import statements sit at
 * the top of each file and are their own sourcemap segments, so lengthening
 * one shifts nothing that the map points into.
 */
async function addExtensions(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      await addExtensions(full)
      continue
    }

    if (!entry.name.endsWith('.js')) {
      continue
    }

    const code = await readFile(full, 'utf8')

    const patched = code.replace(
      /(\bfrom\s*)(["'])(\.[^"']*)\2/g,
      (match, prefix, quote, specifier) => {
        if (/\.(?:js|mjs|cjs|json|css)$/.test(specifier)) {
          return match
        }

        return `${prefix}${quote}${specifier}.js${quote}`
      },
    )

    if (patched !== code) {
      await writeFile(full, patched)
    }
  }
}
