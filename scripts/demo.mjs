/**
 * One command from nothing to a dashboard with data in it.
 *
 *   pnpm demo            # production build, the path where everything works
 *   pnpm demo --dev      # dev server, for working on the module itself
 *
 * Exists because checking a change by hand was a five-step chore: build the
 * module, build the example, remember the two environment variables, start the
 * server, seed it, then find the password. Every step is a chance to test a
 * stale build — which has already happened once, when a dev server started
 * before an endpoint existed and its dashboard looked broken.
 */

import { spawn } from 'node:child_process'
import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Bare switches, so `args.has('no-build')` reads as the question it is. */
const args = new Set(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2)))
const dev = args.has('dev')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || (dev ? 3000 : 3111)

const PASSWORD = 'demo'

const env = {
  ...process.env,
  NUXT_MONITOR_AUTH_PASSWORD: PASSWORD,
  PORT: String(port),
  MONITOR_PASSWORD: PASSWORD,
}

/**
 * Whether the last build is newer than every source file behind it.
 *
 * Rebuilding unconditionally cost minutes on a run whose only purpose was to
 * refill the database, which is the common one. Compared by timestamp rather
 * than by hash: this decides whether to skip work, and being wrong costs a
 * rebuild the user can force anyway.
 */
async function isBuildFresh() {
  const outputs = [
    join(root, 'packages', 'monitor', 'dist', 'module.js'),
    ...(dev ? [] : [join(root, 'example', '.output', 'server', 'index.mjs')]),
  ]

  let builtAt = Infinity

  for (const output of outputs) {
    const stats = await stat(output).catch(() => null)

    if (!stats) {
      return false
    }

    builtAt = Math.min(builtAt, stats.mtimeMs)
  }

  const sources = [
    join(root, 'packages', 'monitor', 'src'),
    join(root, 'packages', 'monitor', 'client'),
    join(root, 'example', 'app'),
    join(root, 'example', 'server'),
  ]

  for (const dir of sources) {
    if (await newestUnder(dir) > builtAt) {
      return false
    }
  }

  return true
}

/** Most recent mtime anywhere under a directory. */
async function newestUnder(dir) {
  let newest = 0

  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = join(current, entry.name)

      if (entry.isDirectory()) {
        await walk(full)
        continue
      }

      const stats = await stat(full).catch(() => null)

      if (stats && stats.mtimeMs > newest) {
        newest = stats.mtimeMs
      }
    }
  }

  await walk(dir)

  return newest
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env, ...options })

    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })
}

/**
 * Waits for *our* server, not just for something on the port.
 *
 * Checked against a monitor endpoint rather than the app root: an unrelated
 * process already listening answers the root perfectly well, and then the
 * seeder fills a database nobody is looking at. That happened — the symptom
 * was a dashboard that looked empty for no reason.
 */
async function waitForServer(base, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const response = await fetch(`${base}/_monitor/api/session`, { method: 'POST' }).catch(() => null)

    // A JSON answer means our handler is registered. HTML means something
    // else is serving this port, or Nuxt is still starting up.
    if (response?.headers.get('content-type')?.includes('application/json')) {
      return true
    }

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  return false
}

async function main() {
  const base = `http://localhost:${port}`

  // Rebuilding takes minutes and is usually unnecessary — the common case is
  // running this again to look at the same build with fresh data.
  const skipBuild = !args.has('build') && (args.has('no-build') || await isBuildFresh())

  if (skipBuild) {
    console.log('\n▸ Reusing the existing build (--build to force).')
  }
  else {
    console.log('\n▸ Building the module…')
    await run('pnpm', ['build'])
  }

  // A fresh database, so counts on screen describe this run and nothing else.
  await rm(join(root, 'example', '.monitor'), { recursive: true, force: true })

  if (!dev && !skipBuild) {
    console.log('\n▸ Building the example…')
    await run('pnpm', ['--dir', 'example', 'build'])
  }

  console.log(`\n▸ Starting the ${dev ? 'dev' : 'production'} server on ${port}…`)

  // Errors are kept, ordinary chatter is not: a dev server that refuses to
  // start must say why, but its request log would bury the URL printed below.
  // Both servers take the port from `PORT` in `env`. Passing `--port` through
  // `pnpm` instead looked like it worked and did not: the flag was swallowed,
  // Nuxt used its default, and the seeder happily filled whatever else was
  // listening on the port nobody was serving.
  const server = dev
    ? spawn('pnpm', ['--dir', 'example', 'dev'], {
        cwd: root,
        env,
        stdio: ['ignore', 'ignore', 'inherit'],
      })
    : spawn('node', ['.output/server/index.mjs'], {
        cwd: join(root, 'example'),
        env,
        stdio: ['ignore', 'ignore', 'inherit'],
      })

  server.on('error', (error) => {
    console.error('Could not start the server:', error.message)
    process.exit(1)
  })

  // Keep the server tied to this process: closing the terminal should not
  // leave a stray one holding the port, which is its own confusing afternoon.
  const stop = () => {
    server.kill()
    process.exit(0)
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  if (!await waitForServer(base)) {
    console.error(`\nNo monitor server answered on ${base}.`)

    // The two ways this fails in practice, both of which look identical from
    // here and neither of which is obvious from the stack Nuxt prints.
    console.error(
      dev
        ? 'Nuxt allows one dev server per project — stop the one you already have running,\n'
          + 'or use `pnpm demo` instead, which builds and serves without the lock.'
        : `Something else may be holding port ${port}. Pass --port to use another.`,
    )

    server.kill()
    process.exit(1)
  }

  console.log('\n▸ Seeding…')
  await run('node', ['scripts/seed.mjs', '--url', base])

  console.log(`
  Dashboard   ${base}/_monitor
  Login       admin / ${PASSWORD}
  App         ${base}

  Ctrl-C to stop.
`)

  // Nothing left to do, but the server is a child of this process.
  await new Promise(() => {})
}

await main()
