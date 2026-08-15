import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MonitorStore } from './store'

/**
 * What people press, per page.
 *
 * Page views rank the pages; this ranks what is used on them. The pair is what
 * makes "which paths deserve a test" answerable: a busy page whose main action
 * nobody triggers and one where everybody does are different problems, and a
 * list of routes alone cannot separate them.
 */

let dir: string
let store: MonitorStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-interactions-'))
  store = await MonitorStore.open({
    dir,
    retentionDays: 14,
    maxEventsPerIssue: 5,
    flushSize: 1_000,
    flushInterval: 60_000,
  })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('counting', () => {
  it('ranks labels by how often they were pressed', async () => {
    for (let i = 0; i < 5; i++) {
      store.countInteraction('/checkout', 'Pay')
    }

    store.countInteraction('/checkout', 'Back')

    const ranked = await store.interactions(60_000)

    expect(ranked.map(row => row.label)).toEqual(['Pay', 'Back'])
    expect(ranked[0]?.count).toBe(5)
  })

  it('keeps the same label on different pages apart', async () => {
    // "Submit" on the signup page and on the contact page are different
    // actions, and merging them would hide which one is actually used.
    store.countInteraction('/signup', 'Submit')
    store.countInteraction('/contact', 'Submit')

    const ranked = await store.interactions(60_000)

    expect(ranked).toHaveLength(2)
    expect(ranked.map(row => row.route).sort()).toEqual(['/contact', '/signup'])
  })

  it('collapses variable segments the way page views do', async () => {
    // Otherwise the busiest button in the application is split across a row
    // per id, exactly as the route facet would be.
    store.countInteraction('/posts/1', 'Like')
    store.countInteraction('/posts/2', 'Like')

    const ranked = await store.interactions(60_000)

    expect(ranked).toHaveLength(1)
    expect(ranked[0]).toMatchObject({ route: '/posts/:id', label: 'Like', count: 2 })
  })

  it('accepts a count, because the browser aggregates before sending', async () => {
    store.countInteraction('/cart', 'Remove', 7)

    expect((await store.interactions(60_000))[0]?.count).toBe(7)
  })

  it('adds up across flushes', async () => {
    store.countInteraction('/cart', 'Buy')
    await store.flush()
    store.countInteraction('/cart', 'Buy', 2)

    expect((await store.interactions(60_000))[0]?.count).toBe(3)
  })

  it('ignores a label that is only whitespace', async () => {
    // An icon-only button has no text; counting it would produce a row nobody
    // can act on, and every such button in the app would share it.
    store.countInteraction('/cart', '   ')

    expect(await store.interactions(60_000)).toEqual([])
  })

  it('is bounded by the window', async () => {
    store.countInteraction('/cart', 'Old', 1, Date.now() - 8 * 24 * 60 * 60 * 1_000)
    store.countInteraction('/cart', 'New')

    expect((await store.interactions(24 * 60 * 60 * 1_000)).map(row => row.label))
      .toEqual(['New'])
  })
})

describe('reading one page', () => {
  it('narrows to a single route', async () => {
    store.countInteraction('/checkout', 'Pay', 3)
    store.countInteraction('/about', 'Contact', 9)

    const ranked = await store.interactions(60_000, { route: '/checkout' })

    expect(ranked).toHaveLength(1)
    expect(ranked[0]).toMatchObject({ label: 'Pay', count: 3 })
  })

  it('normalises the route it is asked for', async () => {
    // The caller has a real path in hand — from a link, from a log — and the
    // counts are filed under the shape. Without this the answer is silently
    // empty rather than wrong, which is harder to notice.
    store.countInteraction('/posts/7', 'Like')

    expect(await store.interactions(60_000, { route: '/posts/7' })).toHaveLength(1)
  })

  it('shares are against the presses in scope', async () => {
    store.countInteraction('/checkout', 'Pay', 3)
    store.countInteraction('/checkout', 'Back', 1)

    const ranked = await store.interactions(60_000, { route: '/checkout' })

    expect(ranked[0]?.share).toBeCloseTo(0.75)
    expect(ranked[1]?.share).toBeCloseTo(0.25)
  })

  it('shares count the tail that the limit cut off', async () => {
    // A share taken over the returned page alone would sum to 1 no matter how
    // much was dropped, so a truncated list would report its top row as far
    // more dominant than it is.
    for (let i = 0; i < 10; i++) {
      store.countInteraction('/menu', `Item ${i}`)
    }

    const ranked = await store.interactions(60_000, { route: '/menu', limit: 2 })

    expect(ranked).toHaveLength(2)
    expect(ranked[0]?.share).toBeCloseTo(0.1)
  })
})

describe('what it refuses to trust', () => {
  it('clamps a forged count', async () => {
    // The number is aggregated in the browser, so it arrives from something
    // that can lie. A ceiling keeps a bad batch to a bounded distortion.
    store.countInteraction('/cart', 'Buy', 10_000_000)

    const [row] = await store.interactions(60_000)

    expect(row?.count).toBe(1_000)
  })

  it('treats a nonsensical count as a single press', async () => {
    store.countInteraction('/cart', 'Buy', Number.NaN)
    store.countInteraction('/cart', 'Buy', -5)

    expect((await store.interactions(60_000))[0]?.count).toBe(2)
  })

  it('truncates a label too long for the column', async () => {
    store.countInteraction('/cart', 'B'.repeat(500))

    expect((await store.interactions(60_000))[0]?.label.length).toBe(80)
  })
})

describe('retention', () => {
  it('drops presses on the window the other counters use', async () => {
    store.countInteraction('/cart', 'Old', 1, Date.now() - 60 * 24 * 60 * 60 * 1_000)
    store.countInteraction('/cart', 'New')
    await store.flush()
    await store.purge()

    expect((await store.interactions(90 * 24 * 60 * 60 * 1_000)).map(row => row.label))
      .toEqual(['New'])
  })
})
