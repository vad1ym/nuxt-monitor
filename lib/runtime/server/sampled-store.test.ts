import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonitorEvent } from '../../types'
import { MonitorStore } from './store'

/**
 * Sampling as the database sees it.
 *
 * The unit tests prove the sampler's arithmetic; these prove the part that
 * actually matters to somebody reading the dashboard — that an issue's count
 * is the number of times it happened, whatever fraction of the occurrences was
 * written, and that a loud issue no longer costs a quiet one its detail.
 */

let dir: string
let store: MonitorStore

function event(message = 'boom'): MonitorEvent {
  return {
    side: 'server',
    type: 'TypeError',
    message,
    stack: `TypeError: ${message}\n    at handler (/app/server/api/x.ts:3:9)`,
    timestamp: Date.now(),
  }
}

async function open(burst: number, keepOneIn = 1_000): Promise<MonitorStore> {
  return MonitorStore.open({
    dir,
    retentionDays: 14,
    maxEventsPerIssue: 100,
    flushSize: 10_000,
    flushInterval: 60_000,
    sampling: burst ? { burst, keepOneIn } : undefined,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-sampling-'))
})

afterEach(async () => {
  await store?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('with sampling off', () => {
  it('stores every occurrence, which is the default', async () => {
    store = await open(0)

    for (let i = 0; i < 30; i++) {
      store.capture(event())
    }

    await store.flush()

    const [issue] = (await store.listIssues()).issues

    expect(issue?.count).toBe(30)
    expect(await store.getEvents(issue!.fingerprint, 100)).toHaveLength(30)
  })
})

describe('with sampling on', () => {
  it('reports the true count while storing far fewer bodies', async () => {
    store = await open(5)

    for (let i = 0; i < 500; i++) {
      store.capture(event())
    }

    await store.flush()

    const [issue] = (await store.listIssues()).issues
    const stored = await store.getEvents(issue!.fingerprint, 1_000)

    // The number a person acts on is exact. What was thinned is the copies.
    expect(issue?.count).toBe(500)
    expect(stored.length).toBeLessThan(20)
    expect(stored.length).toBeGreaterThan(0)
  })

  it('keeps a quiet issue whole while a loud one is thinned', async () => {
    // The failure this exists to prevent: one broken route drowning everything
    // else, both in the buffer and on the screen.
    store = await open(5)

    for (let i = 0; i < 300; i++) {
      store.capture(event('loud'))
    }

    store.capture(event('quiet'))
    await store.flush()

    const { issues } = await store.listIssues()
    const quiet = issues.find(issue => issue.message === 'quiet')

    expect(quiet?.count).toBe(1)
    expect(await store.getEvents(quiet!.fingerprint, 10)).toHaveLength(1)
  })

  it('counts a burst that ends before anything else is written', async () => {
    // The whole spike is sampled out after the burst, and no later occurrence
    // arrives to carry the remainder. Attributing only alongside a stored
    // event would lose precisely the biggest spikes.
    store = await open(2)

    for (let i = 0; i < 50; i++) {
      store.capture(event())
    }

    await store.flush()

    expect((await store.listIssues()).issues[0]?.count).toBe(50)
  })

  it('moves `last_seen` for occurrences it did not store', async () => {
    store = await open(1)

    store.capture(event())
    await store.flush()

    const first = (await store.listIssues()).issues[0]!.lastSeen

    await new Promise(resolve => setTimeout(resolve, 5))

    for (let i = 0; i < 20; i++) {
      store.capture(event())
    }

    await store.flush()

    // An issue firing forty times a second must not read as stale just because
    // its occurrences are being thinned.
    expect((await store.listIssues()).issues[0]!.lastSeen).toBeGreaterThanOrEqual(first)
  })

  it('crosses a threshold on the true count, not the stored one', async () => {
    // The ordering this depends on is subtle: the sampled occurrences have to
    // be added to the count *before* the triggers read it, or a spike of 500
    // would be judged on the dozen bodies that were written and never reach a
    // threshold it passed forty times over.
    const sent: Record<string, unknown>[] = []

    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return new Response('ok', { status: 200 })
    })

    store = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 100,
      flushSize: 10_000,
      flushInterval: 60_000,
      sampling: { burst: 3, keepOneIn: 1_000 },
      notifications: {
        channels: [{ type: 'webhook', url: 'https://hooks.test/a' }],
        groupWindowSeconds: 0,
        // Only the threshold, so the new-issue alert does not mask it.
        triggers: { newIssue: false, thresholds: [100] },
        cooldownMinutes: 0,
      },
    })

    for (let i = 0; i < 300; i++) {
      store.capture(event())
    }

    await store.flush()

    expect(sent).toHaveLength(1)
    expect(String(sent[0]!.text)).toContain('300 occurrences')

    vi.unstubAllGlobals()
  })

  it('says so in health, so a thin database does not look like a quiet one', async () => {
    store = await open(2)

    for (let i = 0; i < 40; i++) {
      store.capture(event())
    }

    await store.flush()

    const health = await store.health()

    expect(health.sampling).toBe(true)
    expect(health.sampled).toBeGreaterThan(0)
  })
})
