import { fileURLToPath } from 'node:url'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { beforeAll, describe, expect, it } from 'vitest'
import { PASSWORD, login, raw, waitForIssue } from './helpers'

/**
 * The whole module against an external database.
 *
 * `external.test.ts` covers the store directly, which is where the dialect
 * differences live. This covers the part that unit tests cannot: that
 * `databaseUrl` survives the trip through `runtimeConfig`, that the Nitro
 * plugin's synchronous `capture` reaches a connection opened asynchronously,
 * and that the dashboard reads back what a real request wrote.
 *
 * Skipped unless `MONITOR_TEST_POSTGRES_URL` is set, so an ordinary run needs
 * no database — see `docs/guide/storage`.
 */

const URL_ = process.env.MONITOR_TEST_POSTGRES_URL

await setup({
  rootDir: fileURLToPath(new URL('../../example', import.meta.url)),
  server: true,
  browser: false,
  env: {
    NUXT_MONITOR_AUTH_PASSWORD: PASSWORD,
    // The point of the file: everything below has to work without a SQLite
    // file existing at all.
    NUXT_MONITOR_DATABASE_URL: URL_ ?? '',
    NUXT_MONITOR_RELEASE: '',
  },
})

describe.skipIf(!URL_)('an external database', () => {
  let cookie: string

  beforeAll(async () => {
    cookie = await login()
  })

  it('collects a server error and serves it to the dashboard', async () => {
    await $fetch('/api/throw', { ignoreResponseError: true } as never).catch(() => {})

    const issue = await waitForIssue(cookie, i => i.message.includes('reading \'url\''))

    expect(issue.side).toBe('server')
    expect(issue.type).toBe('TypeError')
    // Resolved through the sourcemap, which is unrelated to the database but
    // is what makes the issue useful — worth knowing it still happens here.
    expect(issue.culprit).toBeTruthy()
  })

  it('reports itself as healthy, with no byte ceiling', async () => {
    const response = await raw('/_monitor/api/health', { headers: { cookie } })
    const health = await response.json() as {
      enabled: boolean
      bytes: number
      issues: number
    }

    expect(health.enabled).toBe(true)
    // SQLite-only: an external database has its own disk and its own
    // monitoring, so this reports 0 rather than a wrong number.
    expect(health.bytes).toBe(0)
    expect(health.issues).toBeGreaterThan(0)
  })

  it('answers the overview from the same database', async () => {
    const response = await raw('/_monitor/api/overview', { headers: { cookie } })
    const overview = await response.json() as { totalEvents: number, requestCount: number }

    expect(overview.totalEvents).toBeGreaterThan(0)
    // Counters are written on a different path from events, through an upsert
    // each engine spells differently.
    expect(overview.requestCount).toBeGreaterThan(0)
  })
})
