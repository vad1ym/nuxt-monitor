/**
 * Fills a running example app with real errors.
 *
 * Every issue here comes from code that actually ran and actually threw — the
 * example's failing routes, and a browser driven into its client error cases.
 * Nothing is fabricated.
 *
 * An earlier version posted invented stacks to bulk the data out, and that was
 * a mistake worth stating plainly: those issues named files that were never
 * built, so opening one showed no code. A demo whose issues cannot show the
 * failing line is worse than a smaller demo that can — the snippet is the
 * whole point of the tool.
 *
 * Volume comes from repetition instead: the same faults, from several
 * browsers, spread over time, which is also what real traffic looks like.
 *
 *   node scripts/seed.mjs [--url http://localhost:3000] [--scale 1] [--no-browser]
 */

const args = new Map()

for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i]

  if (!flag?.startsWith('--')) {
    continue
  }

  const next = process.argv[i + 1]
  // `--scale 2` takes a value; `--no-browser` is a bare switch. Deciding by
  // what follows keeps both forms working without a schema.
  const takesValue = next !== undefined && !next.startsWith('--')

  args.set(flag.replace(/^--/, ''), takesValue ? next : true)

  if (takesValue) {
    i++
  }
}

const BASE = (args.get('url') ?? 'http://localhost:3000').replace(/\/$/, '')
const SCALE = Number(args.get('scale') ?? 1)

/**
 * Real strings, because the parser is real.
 *
 * These reach the server as a `User-Agent` header and are parsed there, so the
 * browser and OS facets end up populated exactly as they would in production.
 */
const AGENTS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
}

/** The example's server-side failures, each a distinct capture path. */
const SERVER_CASES = [
  { path: '/api/throw', weight: 4 },
  { path: '/api/create-error', weight: 3 },
  { path: '/api/async-throw', weight: 3 },
  { path: '/api/scrub-me?token=leaked-secret', weight: 2 },
  { path: '/middleware-error', weight: 5 },
  { path: '/ssr-error', weight: 3 },
]

/** Successful traffic, so the error rate has a denominator. */
const HEALTHY = ['/', '/client-error', '/fetch-error']

let requests = 0

function pick(values, index) {
  return values[index % values.length]
}

async function hit(path, agent) {
  await fetch(`${BASE}${path}`, { headers: { 'user-agent': agent } }).catch(() => {})
  requests++
}

/**
 * Drives a real browser through the example's client error cases.
 *
 * The only way to get a client error whose stack points at code that exists.
 * Optional: `playwright-core` is a dev dependency of the repo, not of the
 * module, and the seeder is still worth running without it — there just will
 * not be any client-side issues.
 */
async function clientErrors() {
  let chromium

  try {
    ({ chromium } = await import('playwright-core'))
  }
  catch {
    console.log('· skipping client errors (playwright-core not installed)')
    return
  }

  let browser

  try {
    browser = await chromium.launch({ channel: 'chromium' })
  }
  catch {
    console.log('· skipping client errors (no Chromium available)')
    return
  }

  const rounds = Math.max(1, Math.round(3 * SCALE))

  try {
    for (let round = 0; round < rounds; round++) {
      // A fresh context per round means a fresh sessionStorage, and so a
      // distinct session — which is what makes the session counts meaningful.
      const context = await browser.newContext({ userAgent: pick(Object.values(AGENTS), round) })
      const page = await context.newPage()

      // A component error raised after hydration, through `vue:error`.
      await page.goto(`${BASE}/client-error`, { waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForTimeout(900)
      await page.click('button').catch(() => {})
      await page.waitForTimeout(900)

      // Errors outside Vue: a throwing handler, a rejected promise, a timer.
      await page.goto(BASE, { waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForTimeout(900)

      for (const label of ['Thrown from a click', 'Unhandled rejection', 'Thrown from a timer']) {
        await page.getByRole('button', { name: new RegExp(label, 'i') }).click().catch(() => {})
        await page.waitForTimeout(300)
      }

      // Route middleware, and a `useFetch` against a failing route.
      await page.goto(`${BASE}/route-middleware-error`, { waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForTimeout(700)
      await page.goto(`${BASE}/fetch-error`, { waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForTimeout(900)

      // The queue batches and flushes on hide; without this the last events
      // leave with the browser.
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))).catch(() => {})
      await page.waitForTimeout(700)
      await context.close()
    }

    console.log(`· client errors captured (${rounds} ${rounds === 1 ? 'session' : 'sessions'})`)
  }
  finally {
    await browser.close()
  }
}

async function main() {
  const reachable = await fetch(BASE, { method: 'HEAD' }).catch(() => null)

  if (!reachable) {
    console.error(`No server at ${BASE}. Start one first, e.g. \`pnpm demo\`.`)
    process.exit(1)
  }

  console.log(`Seeding ${BASE} (scale ${SCALE})…`)

  // Server errors, weighted so the list has a shape rather than one of each.
  const agents = Object.values(AGENTS)
  let index = 0

  for (const testCase of SERVER_CASES) {
    for (let i = 0; i < Math.round(testCase.weight * SCALE); i++) {
      await hit(testCase.path, pick(agents, index++))
    }
  }

  // Successful requests, so error rates are a fraction of something.
  for (let i = 0; i < Math.round(40 * SCALE); i++) {
    await hit(pick(HEALTHY, i), pick(agents, index++))
  }

  console.log(`· ${requests} requests made`)

  if (args.get('no-browser') === undefined) {
    await clientErrors()
  }

  console.log(`\nDone. Open ${BASE}/_monitor to see them.`)
}

await main()
