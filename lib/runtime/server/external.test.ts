import { describe, expect, it } from 'vitest'
import { MonitorStore } from './store'
import type { MonitorEvent } from '../../types'

/**
 * The store against real MySQL and Postgres servers.
 *
 * SQLite is covered exhaustively by `store.test.ts`; what those cannot catch
 * is the part that differs per engine — schema types, upserts, identifier
 * quoting, how many rows a delete says it touched. Every one of the fixes
 * these cover was found by running this against a live server, not by reading
 * the documentation.
 *
 * Skipped unless `MONITOR_TEST_POSTGRES_URL` / `MONITOR_TEST_MYSQL_URL` are
 * set, so an ordinary `pnpm test` needs no databases. See `docs/guide/storage`
 * for the two `docker run` lines that provide them.
 */

const TARGETS = [
  ['postgresql', process.env.MONITOR_TEST_POSTGRES_URL],
  ['mysql', process.env.MONITOR_TEST_MYSQL_URL],
] as const

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    side: 'server',
    type: 'TypeError',
    message: 'boom',
    timestamp: Date.now(),
    stack: 'TypeError: boom\n    at handler (/app/server/api/x.ts:3:9)',
    facets: { browser: 'Chrome', os: 'macOS', release: '1.0.0', session: 's1' },
    context: { url: '/api/x', method: 'GET', statusCode: 500 },
    ...overrides,
  }
}

for (const [name, url] of TARGETS) {
  describe.skipIf(!url)(name, () => {
    async function open(): Promise<MonitorStore> {
      const store = await MonitorStore.open({
        dir: '/tmp/monitor-external-unused',
        url,
        retentionDays: 14,
        maxEventsPerIssue: 5,
        flushSize: 10_000,
        flushInterval: 60_000,
      })

      // Each test starts from an empty database: these run against a shared
      // server, and a leftover row from the previous one would make a count
      // assertion pass or fail for the wrong reason.
      await store.reset()

      return store
    }

    it('creates its schema and groups occurrences into issues', async () => {
      const store = await open()

      store.capture(makeEvent())
      store.capture(makeEvent())
      store.capture(makeEvent({
        message: 'other',
        stack: 'Error: other\n    at f (/app/server/api/y.ts:1:1)',
      }))
      await store.flush()

      const { issues, total } = await store.listIssues()

      // Two distinct faults; the first seen twice — which is the upsert
      // working, the part every engine spells differently.
      expect(total).toBe(2)
      expect(issues.map(issue => issue.count).sort()).toEqual([1, 2])

      await store.close()
    })

    /** `release` is a reserved word in MySQL and has to be quoted. */
    it('reads facets, including the reserved-word column', async () => {
      const store = await open()

      store.capture(makeEvent())
      await store.flush()

      const [issue] = (await store.listIssues()).issues
      const facets = await store.facetCounts({ fingerprint: issue!.fingerprint })

      expect(facets.release.map(value => value.value)).toEqual(['1.0.0'])
      expect(facets.browser.map(value => value.value)).toEqual(['Chrome'])

      await store.close()
    })

    it('stores each occurrence and reads them back', async () => {
      const store = await open()

      // Same fault twice, reported with different ids in the message —
      // normalisation groups them, and each occurrence keeps its own text.
      store.capture(makeEvent({ message: 'user 1 not found' }))
      store.capture(makeEvent({ message: 'user 2 not found' }))
      await store.flush()

      const { issues, total } = await store.listIssues()

      expect(total).toBe(1)

      const events = await store.getEvents(issues[0]!.fingerprint, 10)

      expect(events.map(event => event.message).sort())
        .toEqual(['user 1 not found', 'user 2 not found'])

      await store.close()
    })

    it('counts requests and reports an error rate', async () => {
      const store = await open()

      store.countRequest('/api/x', 'GET', 200)
      store.countRequest('/api/x', 'GET', 500)
      store.capture(makeEvent())
      await store.flush()

      const overview = await store.overview()

      expect(overview.requestCount).toBe(2)
      expect(overview.failedRequestCount).toBe(1)
      expect(overview.errorRate).toBeCloseTo(0.5)
      // `topRoutes` is the query whose HAVING clause Postgres rejects when it
      // refers to a select-list alias.
      expect(overview.topRoutes[0]?.route).toBe('/api/x')

      await store.close()
    })

    it('applies retention and reports how much it removed', async () => {
      const store = await open()

      const old = Date.now() - 90 * 24 * 60 * 60 * 1_000

      store.capture(makeEvent({ timestamp: old }))
      await store.flush()

      // Deleting has to report a row count, and each driver names that
      // differently — a wrong reading here is silent, since nothing throws.
      const removed = await store.purge()

      expect(removed.events).toBe(1)
      expect((await store.listIssues()).total).toBe(0)

      await store.close()
    })

    it('caps stored events per issue', async () => {
      const store = await open()

      // `maxEventsPerIssue` is 5 above, and trimming uses a LIMIT inside a
      // subquery — which MySQL refuses without a derived table.
      for (let i = 0; i < 12; i++) {
        store.capture(makeEvent({ message: `occurrence ${i}` }))
      }

      await store.flush()

      const [issue] = (await store.listIssues()).issues

      expect(await store.eventCount(issue!.fingerprint)).toBe(5)
      // The issue's own count still reflects every occurrence.
      expect(issue!.count).toBe(12)

      await store.close()
    })

    it('resolves and reopens an issue', async () => {
      const store = await open()

      store.capture(makeEvent())
      await store.flush()

      const fp = (await store.listIssues()).issues[0]!.fingerprint

      expect(await store.setResolved(fp, true)).toBe(true)
      expect((await store.getIssue(fp))!.resolved).toBe(true)

      store.capture(makeEvent())
      await store.flush()

      // A resolved issue that happens again is not resolved.
      expect((await store.getIssue(fp))!.resolved).toBe(false)

      await store.close()
    })

    /**
     * The byte ceiling is SQLite-only: it counts pages through a PRAGMA. An
     * external database has its own disk and its own monitoring, so `bytes`
     * reports 0 and `retentionDays`/`maxIssues` are what bound growth.
     */
    it('reports health without a byte ceiling', async () => {
      const store = await open()

      store.capture(makeEvent())
      await store.flush()

      const health = await store.health()

      expect(health.enabled).toBe(true)
      expect(health.bytes).toBe(0)
      expect(health.issues).toBe(1)
      expect(health.events).toBe(1)

      await store.close()
    })
  })
}
