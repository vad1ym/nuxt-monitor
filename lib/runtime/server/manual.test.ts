import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonitorEvent, MonitorNotificationOptions } from '../../types'
import { EXCEPTION_TYPE, callSiteStack } from '../shared/exception'
import { MonitorStore } from './store'

/**
 * Manual reports, from the store's point of view.
 *
 * `exception()` itself needs `#imports` and a Nuxt app, so what is exercised
 * here is the event it produces: how a hand-raised report is stored, how it is
 * kept apart from a caught error, and how a priority group decides which
 * channel hears about it.
 */

let dir: string
let store: MonitorStore
let sent: { url: string, body: Record<string, unknown> }[]

/** What `exception('...', { group, level })` hands the store. */
function manual(message: string, extra: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    side: 'server',
    type: EXCEPTION_TYPE,
    message,
    stack: callSiteStack(1),
    timestamp: Date.now(),
    manual: true,
    level: 'error',
    ...extra,
  }
}

function caught(message = 'boom'): MonitorEvent {
  return { side: 'server', type: 'TypeError', message, timestamp: Date.now() }
}

async function open(notifications?: Partial<MonitorNotificationOptions>): Promise<MonitorStore> {
  return MonitorStore.open({
    dir,
    retentionDays: 14,
    maxEventsPerIssue: 5,
    flushSize: 1_000,
    flushInterval: 60_000,
    notifications: notifications && {
      dashboardUrl: 'https://app.test/_monitor',
      groupWindowSeconds: 0,
      ...notifications,
    },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-manual-'))
  sent = []

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) })
    return new Response('ok', { status: 200 })
  })
})

afterEach(async () => {
  await store?.close()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('storing a manual report', () => {
  it('keeps the level and the group on the issue', async () => {
    store = await open()
    store.capture(manual('Charged total does not match', { level: 'critical', group: 'payments' }))
    await store.flush()

    const [issue] = (await store.listIssues()).issues

    expect(issue).toMatchObject({ manual: true, level: 'critical', group: 'payments' })
  })

  it('leaves a caught error with none of the three', async () => {
    // Not `manual: false` — a caught error has no opinion about any of this,
    // and a field that is always present but means nothing is noise in the API.
    store = await open()
    store.capture(caught())
    await store.flush()

    const [issue] = (await store.listIssues()).issues

    expect(issue?.manual).toBeUndefined()
    expect(issue?.level).toBeUndefined()
    expect(issue?.group).toBeUndefined()
  })

  it('separates the same report raised under two groups', async () => {
    store = await open()
    store.capture(manual('totals disagree', { group: 'payments' }))
    store.capture(manual('totals disagree', { group: 'data-integrity' }))
    await store.flush()

    // Two things worth watching apart. Naming a group is precisely the claim
    // that they are not the same concern.
    expect((await store.listIssues()).total).toBe(2)
  })

  it('groups repeats of one report into a single issue', async () => {
    store = await open()

    const event = manual('inventory drifted', { group: 'data-integrity' })
    store.capture({ ...event })
    store.capture({ ...event })
    await store.flush()

    const { issues, total } = await store.listIssues()

    expect(total).toBe(1)
    expect(issues[0]?.count).toBe(2)
  })
})

describe('filtering', () => {
  beforeEach(async () => {
    store = await open()
    store.capture(caught())
    store.capture(manual('totals disagree', { group: 'payments', level: 'critical' }))
    store.capture(manual('token refresh failed', { group: 'auth', level: 'warning' }))
    await store.flush()
  })

  it('shows manual reports on their own', async () => {
    const { issues } = await store.listIssues({ manual: true })

    expect(issues).toHaveLength(2)
    expect(issues.every(issue => issue.manual)).toBe(true)
  })

  it('shows caught errors on their own', async () => {
    const { issues } = await store.listIssues({ manual: false })

    expect(issues).toHaveLength(1)
    expect(issues[0]?.type).toBe('TypeError')
  })

  it('narrows to one group', async () => {
    const { issues } = await store.listIssues({ group: 'payments' })

    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toBe('totals disagree')
  })

  it('narrows to one level', async () => {
    const { issues } = await store.listIssues({ level: 'critical' })

    expect(issues).toHaveLength(1)
    expect(issues[0]?.group).toBe('payments')
  })

  it('mixes both by default, which is the whole list', async () => {
    expect((await store.listIssues()).total).toBe(3)
  })
})

describe('routing alerts by group', () => {
  it('sends a group only to the channel that asked for it', async () => {
    store = await open({
      channels: [
        { type: 'webhook', url: 'https://hooks.test/payments', name: 'payments-chat', groups: ['payments'] },
        { type: 'webhook', url: 'https://hooks.test/all', name: 'general' },
      ],
    })

    store.capture(manual('totals disagree', { group: 'payments', level: 'critical' }))
    await store.flush()

    expect(sent.map(request => request.url).sort()).toEqual([
      'https://hooks.test/all',
      'https://hooks.test/payments',
    ])
  })

  it('keeps a caught error out of a channel that named a group', async () => {
    store = await open({
      channels: [
        { type: 'webhook', url: 'https://hooks.test/payments', name: 'payments-chat', groups: ['payments'] },
        { type: 'webhook', url: 'https://hooks.test/all', name: 'general' },
      ],
    })

    store.capture(caught())
    await store.flush()

    expect(sent.map(request => request.url)).toEqual(['https://hooks.test/all'])
  })

  it('respects a level floor', async () => {
    store = await open({
      channels: [{ type: 'webhook', url: 'https://hooks.test/urgent', minLevel: 'critical' }],
    })

    store.capture(manual('minor drift', { level: 'info', group: 'data-integrity' }))
    await store.flush()

    expect(sent).toHaveLength(0)
  })

  it('logs nothing for a channel whose filters excluded everything', async () => {
    // Distinct from quiet hours, which withholds something the reader would
    // otherwise have received. A filtered channel did what it was told.
    store = await open({
      channels: [{ type: 'webhook', url: 'https://hooks.test/payments', groups: ['payments'] }],
    })

    store.capture(caught())
    await store.flush()

    expect(await store.deliveries()).toHaveLength(0)
  })

  it('names the group and level in the message, not the type', async () => {
    // `MonitorException` is the type of every manual report, so printing it
    // says nothing. What the caller chose to tell us takes the slot.
    store = await open({ channels: [{ type: 'webhook', url: 'https://hooks.test/a' }] })

    store.capture(manual('totals disagree', { group: 'payments', level: 'critical' }))
    await store.flush()

    expect(sent[0]?.body.text).toContain('payments/critical')
    expect(sent[0]?.body.text).not.toContain('MonitorException')
  })
})

describe('endpoints against pages', () => {
  it('separates a failing endpoint from a failing page', async () => {
    // Both are `side: 'server'`, and they are not the same problem: one is an
    // integration every consumer sees, the other is a page one visitor sees.
    store = await open()
    store.capture({ ...caught('endpoint blew up'), kind: 'api' })
    store.capture({ ...caught('page blew up'), kind: 'page' })
    await store.flush()

    const api = await store.listIssues({ kind: 'api' })
    const pages = await store.listIssues({ kind: 'page' })

    expect(api.issues.map(issue => issue.message)).toEqual(['endpoint blew up'])
    expect(pages.issues.map(issue => issue.message)).toEqual(['page blew up'])
  })

  it('carries the kind onto the issue', async () => {
    store = await open()
    store.capture({ ...caught(), kind: 'api' })
    await store.flush()

    expect((await store.listIssues()).issues[0]?.kind).toBe('api')
  })

  it('leaves it unset when nothing classified it', async () => {
    store = await open()
    store.capture(caught())
    await store.flush()

    expect((await store.listIssues()).issues[0]?.kind).toBeUndefined()
  })
})

describe('groups from config rules', () => {
  async function withRules(): Promise<MonitorStore> {
    return MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 5,
      flushSize: 1_000,
      flushInterval: 60_000,
      groups: {
        payments: { routes: ['/api/checkout/**'], notify: true },
        'third-party': { messages: ['stripe'] },
      },
      notifications: {
        channels: [{ type: 'webhook', url: 'https://hooks.test/a' }],
        groupWindowSeconds: 0,
        dashboardUrl: 'https://app.test/_monitor',
      },
    })
  }

  it('labels a caught error nobody annotated', async () => {
    store = await withRules()
    store.capture({ ...caught('checkout blew up'), context: { url: '/api/checkout/confirm' } })
    await store.flush()

    expect((await store.listIssues()).issues[0]?.group).toBe('payments')
  })

  it('labels by message when the path says nothing', async () => {
    store = await withRules()
    store.capture({ ...caught('Stripe refused the charge'), context: { url: '/api/orders' } })
    await store.flush()

    expect((await store.listIssues()).issues[0]?.group).toBe('third-party')
  })

  it('does not change the fingerprint of an error a rule labels', async () => {
    // The asymmetry with `exception()`, and the reason for it: turning the
    // option on must not re-key every existing issue, or work in progress
    // reads as freshly discovered.
    const unlabelled = await MonitorStore.open({
      dir: mkdtempSync(join(tmpdir(), 'monitor-nogroups-')),
      retentionDays: 14,
      maxEventsPerIssue: 5,
      flushSize: 1_000,
      flushInterval: 60_000,
    })

    const event = { ...caught('checkout blew up'), context: { url: '/api/checkout' } }

    unlabelled.capture(event)
    await unlabelled.flush()
    const before = (await unlabelled.listIssues()).issues[0]!.fingerprint
    await unlabelled.close()

    store = await withRules()
    store.capture(event)
    await store.flush()

    const [issue] = (await store.listIssues()).issues

    expect(issue?.fingerprint).toBe(before)
    expect(issue?.group).toBe('payments')
  })

  it('lets an explicit group win over a rule', async () => {
    // `exception(…, { group })` is a statement by whoever wrote the code; a
    // rule is an inference from a coincidence of path.
    store = await withRules()
    store.capture(manual('totals disagree', {
      group: 'data-integrity',
      context: { url: '/api/checkout' },
    }))
    await store.flush()

    expect((await store.listIssues()).issues[0]?.group).toBe('data-integrity')
  })

  it('alerts on a watched group when no other trigger would', async () => {
    // The second occurrence of a known issue is normally silent: not new, not
    // a regression, no threshold crossed. `notify: true` is what makes the
    // group worth hearing about anyway.
    store = await withRules()

    store.capture({ ...caught('checkout blew up'), context: { url: '/api/checkout' } })
    await store.flush()

    // `cooldownMinutes` defaults to 60, and the first alert started it — so
    // the second occurrence is held back by the cooldown rather than by the
    // trigger. Reopen with no cooldown to see the trigger itself.
    await store.close()
    sent.length = 0

    store = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 5,
      flushSize: 1_000,
      flushInterval: 60_000,
      groups: { payments: { routes: ['/api/checkout/**'], notify: true } },
      notifications: {
        channels: [{ type: 'webhook', url: 'https://hooks.test/a' }],
        groupWindowSeconds: 0,
        cooldownMinutes: 0,
      },
    })

    store.capture({ ...caught('checkout blew up'), context: { url: '/api/checkout' } })
    await store.flush()

    expect(sent).toHaveLength(1)
    expect(String(sent[0]!.body.text)).toContain('Watched group')
  })

  it('stays quiet for a group without notify', async () => {
    store = await withRules()

    store.capture({ ...caught('Stripe refused the charge'), context: { url: '/api/orders' } })
    await store.flush()
    sent.length = 0

    // Second occurrence: labelled `third-party`, which did not ask to be
    // watched, so nothing is sent.
    store.capture({ ...caught('Stripe refused the charge'), context: { url: '/api/orders' } })
    await store.flush()

    expect(sent).toHaveLength(0)
  })
})
