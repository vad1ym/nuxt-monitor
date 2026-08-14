import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonitorEvent, MonitorNotificationOptions } from '../../../types'
import { MonitorStore } from '../store'

/**
 * Alerting end to end, from a captured error to an outbound request.
 *
 * The channel is the seam: `fetch` is replaced, so what is asserted is what
 * would have gone out — the triggers, the cooldown, the grouping and the quiet
 * window are all decided before it and are all observable there.
 */

let dir: string
let store: MonitorStore
let sent: { url: string, body: Record<string, unknown> }[]

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    side: 'server',
    type: 'TypeError',
    message: 'boom',
    timestamp: Date.now(),
    ...overrides,
  }
}

/** The reasons inside one webhook payload. `alerts` is the array; there is no top-level `reason`. */
function reasonsOf(entry: { body: Record<string, unknown> }): string[] {
  return ((entry.body.alerts ?? []) as { reason: string }[]).map(alert => alert.reason)
}

/** A store whose alerts go to a webhook this test can read. */
async function open(notifications: Partial<MonitorNotificationOptions> = {}): Promise<MonitorStore> {
  return MonitorStore.open({
    dir,
    retentionDays: 14,
    maxEventsPerIssue: 5,
    flushSize: 1_000,
    flushInterval: 60_000,
    notifications: {
      channels: [{ type: 'webhook', url: 'https://hooks.test/alert' }],
      dashboardUrl: 'https://app.test/_monitor',
      // Sent as they are raised, so a test does not wait out a group window.
      // Grouping has a test of its own below.
      groupWindowSeconds: 0,
      ...notifications,
    },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-notify-'))
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

describe('what raises an alert', () => {
  it('sends for a fingerprint never seen before', async () => {
    store = await open()
    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://hooks.test/alert')
    expect(sent[0]!.body.text).toContain('New issue')
  })

  it('stays quiet on the second occurrence of the same issue', async () => {
    store = await open()
    store.capture(makeEvent())
    await store.flush()
    store.capture(makeEvent())
    await store.flush()

    // The whole point of the feature: one message about a thing, not one per
    // occurrence of it.
    expect(sent).toHaveLength(1)
  })

  it('sends again when a resolved issue happens once more', async () => {
    store = await open()
    store.capture(makeEvent())
    await store.flush()

    const [issue] = (await store.listIssues()).issues
    await store.setResolved(issue!.fingerprint, true)

    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(2)
    expect(sent[1]!.body.text).toContain('Regression')
  })

  it('sends nothing at all when no channel is configured', async () => {
    store = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 5,
      flushSize: 1_000,
      flushInterval: 60_000,
    })

    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(0)
    expect(store.alerts).toBeUndefined()
  })

  it('says nothing about an issue that has been ignored', async () => {
    store = await open()
    store.capture(makeEvent())
    await store.flush()

    const [issue] = (await store.listIssues()).issues
    await store.setIgnored(issue!.fingerprint, true)
    await store.setResolved(issue!.fingerprint, true)

    // Would be a regression but for the ignore flag, which is the stronger
    // statement: this one is not mine to hear about.
    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(1)
  })
})

describe('credentials supplied at runtime', () => {
  it('fills in a webhook URL the channel left blank', async () => {
    // A channel is an array entry, which `NUXT_MONITOR_*` cannot reach into —
    // so without the flat option the only place for a secret is the config
    // file, which is baked into the build artefact.
    store = await open({
      channels: [{ type: 'webhook' }],
      webhookUrl: 'https://hooks.test/from-env',
    })

    store.capture(makeEvent())
    await store.flush()

    expect(sent[0]?.url).toBe('https://hooks.test/from-env')
  })

  it('lets a value on the channel win over the runtime one', async () => {
    store = await open({
      channels: [{ type: 'webhook', url: 'https://hooks.test/explicit' }],
      webhookUrl: 'https://hooks.test/from-env',
    })

    store.capture(makeEvent())
    await store.flush()

    expect(sent[0]?.url).toBe('https://hooks.test/explicit')
  })

  it('skips a channel that has no credentials from either source', async () => {
    // Dropped rather than kept and failed on every alert: half a configuration
    // is a mistake to report once at startup, not one to rediscover at 3am.
    store = await open({ channels: [{ type: 'telegram' }] })

    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(0)
    expect(store.alerts).toBeUndefined()
  })

  it('skips a Telegram channel that has a token but no chat', async () => {
    store = await open({
      channels: [{ type: 'telegram', token: 'abc' }],
      // No chat id anywhere: half a channel cannot deliver.
    })

    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(0)
  })
})

describe('the cooldown', () => {
  it('holds back a threshold alert raised inside the window', async () => {
    store = await open({ triggers: { thresholds: [2, 3] }, cooldownMinutes: 60 })

    store.capture(makeEvent())
    await store.flush()
    expect(sent).toHaveLength(1)

    // Crosses 2, but the new-issue alert started the cooldown a moment ago.
    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(1)
  })

  it('lets a threshold through once the window has passed', async () => {
    store = await open({ triggers: { thresholds: [2] }, cooldownMinutes: 0 })

    store.capture(makeEvent())
    await store.flush()
    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(2)
    expect(sent[1]!.body.text).toContain('Issue growing')
  })

  it('survives a restart, because it lives on the issue row', async () => {
    store = await open({ triggers: { thresholds: [2] }, cooldownMinutes: 60 })

    store.capture(makeEvent())
    await store.flush()
    await store.close()

    // A deploy is exactly when alerts fire, so an in-memory cooldown would be
    // reset at the worst possible moment.
    store = await open({ triggers: { thresholds: [2] }, cooldownMinutes: 60 })
    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(1)
  })
})

describe('grouping', () => {
  it('sends one message about several issues raised together', async () => {
    store = await open({ groupWindowSeconds: 0.05 })

    store.capture(makeEvent({ message: 'first' }))
    store.capture(makeEvent({ message: 'second' }))
    await store.flush()

    // Still inside the window.
    expect(sent).toHaveLength(0)

    await store.close()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.body.alerts).toHaveLength(2)
    expect(sent[0]!.body.text).toContain('2 × New issue')
  })
})

describe('quiet hours', () => {
  it('suppresses the send and records why', async () => {
    const hour = new Date().getHours()
    // A window that certainly contains now, whenever the test runs.
    const pad = (value: number): string => String(value).padStart(2, '0')

    store = await open({
      quietHours: { from: `${pad(hour)}:00`, to: `${pad((hour + 1) % 24)}:00` },
    })

    store.capture(makeEvent())
    await store.flush()

    expect(sent).toHaveLength(0)

    const [delivery] = await store.deliveries()

    // Logged rather than dropped: "did anything happen overnight" has to have
    // an answer in the morning.
    expect(delivery?.status).toBe('suppressed')
    expect(delivery?.detail).toBe('quiet hours')
  })
})

describe('the delivery log', () => {
  it('records a successful send with its channel and reason', async () => {
    store = await open({ channels: [{ type: 'webhook', url: 'https://hooks.test/alert', name: 'ops-chat' }] })

    store.capture(makeEvent())
    await store.flush()

    const [delivery] = await store.deliveries()

    expect(delivery).toMatchObject({ channel: 'ops-chat', reason: 'new-issue', status: 'sent', alerts: 1 })
    expect(delivery?.fingerprint).toBeTruthy()
  })

  it('names the issue a sent alert was about', async () => {
    store = await open()
    store.capture(makeEvent({ message: 'cart total exploded' }))
    await store.flush()

    // "New issue, sent, 10m ago" cannot be matched against a message somebody
    // remembers receiving, which is the comparison the log is opened to make.
    expect((await store.deliveries())[0]?.issue).toMatchObject({
      type: 'TypeError',
      message: 'cart total exploded',
    })
  })

  it('records a failure with the reason it failed', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))

    store = await open()
    store.capture(makeEvent())
    await store.flush()

    const [delivery] = await store.deliveries()

    expect(delivery?.status).toBe('failed')
    expect(delivery?.detail).toContain('500')
  })

  it('keeps collecting when a channel throws outright', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('getaddrinfo ENOTFOUND hooks.test')
    })

    store = await open()
    store.capture(makeEvent())
    await store.flush()

    // The events are the product; the alert is downstream of them.
    expect((await store.listIssues()).total).toBe(1)
    expect((await store.deliveries())[0]?.status).toBe('failed')
  })
})

describe('slack', () => {
  it('posts blocks to an incoming webhook', async () => {
    store = await open({
      channels: [{ type: 'slack', webhookUrl: 'https://hooks.slack.com/services/T/B/x' }],
    })
    store.capture(makeEvent())
    await store.flush()
    await store.alerts!.settled()

    expect(sent[0]!.url).toBe('https://hooks.slack.com/services/T/B/x')
    expect(sent[0]!.body.blocks).toBeInstanceOf(Array)
    // The preview text travels with the blocks; without it the phone
    // notification is blank.
    expect(sent[0]!.body.text).toContain('New issue')
  })

  it('posts through the API when given a token and a channel', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) })

      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    store = await open({
      channels: [{ type: 'slack', token: 'xoxb-test', channel: '#alerts' }],
    })
    store.capture(makeEvent())
    await store.flush()
    await store.alerts!.settled()

    expect(sent[0]!.url).toBe('https://slack.com/api/chat.postMessage')
    expect(sent[0]!.body.channel).toBe('#alerts')
    expect((await store.deliveries())[0]?.status).toBe('sent')
  })

  /**
   * The one failure this feature cannot afford to hide.
   *
   * `chat.postMessage` answers 200 with `ok: false` for everything that
   * actually goes wrong — a revoked token, a bot that was removed from the
   * channel. Trusting the status alone would write "sent" to the log for a
   * message nobody received, and the log is what people consult when asking
   * why they were never told.
   */
  it('treats a 200 carrying ok:false as a failure', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), { status: 200 }))

    store = await open({
      channels: [{ type: 'slack', token: 'xoxb-test', channel: '#alerts' }],
    })
    store.capture(makeEvent())
    await store.flush()
    await store.alerts!.settled()

    const [delivery] = await store.deliveries()

    expect(delivery?.status).toBe('failed')
    // Slack's own word for it: the fix is to invite the bot, and no paraphrase
    // of ours would say that as precisely.
    expect(delivery?.detail).toContain('not_in_channel')
  })

  it('sends once when a channel carries both a hook and a token', async () => {
    store = await open({
      channels: [{
        type: 'slack',
        webhookUrl: 'https://hooks.slack.com/services/T/B/x',
        token: 'xoxb-test',
        channel: '#alerts',
      }],
    })
    store.capture(makeEvent())
    await store.flush()
    await store.alerts!.settled()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toContain('hooks.slack.com')
  })

  it('skips a token with no channel to post to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store = await open({ channels: [{ type: 'slack', token: 'xoxb-test' }] })
    store.capture(makeEvent())
    await store.flush()

    // No `settled()` here: an unusable channel leaves the notifier unbuilt
    // altogether, which is the assertion.
    expect(store.alerts).toBeUndefined()
    expect(sent).toHaveLength(0)
    expect(warn.mock.calls.flat().join(' ')).toContain('channel')
    warn.mockRestore()
  })

  it('takes its credentials from the runtime when the channel leaves them off', async () => {
    // The reason these exist: a channel is an array entry, and `NUXT_MONITOR_*`
    // cannot reach into a list — so a hook URL would otherwise have to be
    // written in the config file and baked into the build.
    store = await open({
      channels: [{ type: 'slack' }],
      slackWebhookUrl: 'https://hooks.slack.com/services/from/env',
    })
    store.capture(makeEvent())
    await store.flush()
    await store.alerts!.settled()

    expect(sent[0]!.url).toBe('https://hooks.slack.com/services/from/env')
  })
})

describe('the test alert', () => {
  it('goes out immediately, without a trigger or a group window', async () => {
    store = await open({ groupWindowSeconds: 30 })

    const deliveries = await store.alerts!.sendNow({
      reason: 'test',
      at: Date.now(),
      issue: {
        fingerprint: 'test',
        type: 'MonitorTest',
        message: 'Delivery is working.',
        side: 'server',
        count: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        resolved: false,
        ignored: false,
      },
    })

    expect(sent).toHaveLength(1)
    expect(deliveries[0]?.status).toBe('sent')
  })
})

/**
 * The application-wide trigger, through the real store.
 *
 * Worth an end-to-end test rather than only a unit one because the query it
 * depends on is where this goes wrong quietly: `class` holds `'5xx'` as text,
 * and comparing it against the number 5 matches no row — the trigger then
 * never fires, and never firing is indistinguishable from working.
 */
describe('the application error rate', () => {
  it('alerts once the failure rate crosses the threshold', async () => {
    store = await open({ triggers: { errorRate: 0.25 } })

    const now = Date.now()

    for (let i = 0; i < 30; i++) {
      store.countRequest('/api/checkout', 'POST', i < 12 ? 500 : 200, now)
    }

    // An error has to be captured for a flush to evaluate anything at all.
    store.capture(makeEvent({ timestamp: now }))
    await store.flush()

    // The rate alert is enqueued after the per-issue loop, so its send lands a
    // tick later than the new-issue one.
    await new Promise(resolve => setTimeout(resolve, 0))

    const rate = sent.find(entry => reasonsOf(entry).includes('error-rate'))

    expect(rate).toBeDefined()
    expect(String(rate!.body.text)).toContain('40% of requests failed')
  })

  it('stays quiet when the rate is healthy', async () => {
    store = await open({ triggers: { errorRate: 0.25 } })

    const now = Date.now()

    for (let i = 0; i < 30; i++) {
      store.countRequest('/api/checkout', 'POST', i < 2 ? 500 : 200, now)
    }

    store.capture(makeEvent({ timestamp: now }))
    await store.flush()

    expect(sent.some(entry => reasonsOf(entry).includes('error-rate'))).toBe(false)
  })

  it('is off unless configured', async () => {
    store = await open()

    const now = Date.now()

    for (let i = 0; i < 30; i++) {
      store.countRequest('/api/checkout', 'POST', 500, now)
    }

    store.capture(makeEvent({ timestamp: now }))
    await store.flush()

    expect(sent.some(entry => reasonsOf(entry).includes('error-rate'))).toBe(false)
  })

  it('does not repeat itself on every flush', async () => {
    // The cooldown that keeps an outage from becoming a message per flush.
    store = await open({ triggers: { errorRate: 0.25 } })

    const now = Date.now()

    for (let i = 0; i < 30; i++) {
      store.countRequest('/api/checkout', 'POST', 500, now)
    }

    store.capture(makeEvent({ timestamp: now }))
    await store.flush()

    store.capture(makeEvent({ message: 'again', timestamp: now }))
    await store.flush()

    expect(sent.filter(entry => reasonsOf(entry).includes('error-rate'))).toHaveLength(1)
  })
})

describe('silence', () => {
  const HOUR = 60 * 60 * 1_000

  /**
   * History old enough and busy enough to arm the trigger.
   *
   * Written straight to the counter table rather than through `countRequest`,
   * because the whole point is traffic that happened *hours* ago and stopped —
   * which is not something the collector can be asked to produce live.
   */
  async function seedTraffic(db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }, at: number, count: number): Promise<void> {
    await db.prepare(
      'INSERT INTO request_stats (bucket, route, method, class, count) VALUES (?, ?, ?, ?, ?)',
    ).run(Math.floor(at / 60_000) * 60_000, '/api/x', 'GET', '2xx', count)
  }

  it('reports that nothing has arrived for a long time', async () => {
    // The condition no other trigger can see: every one of them watches a
    // number get worse, and a collector that stopped produces no numbers.
    store = await open({ triggers: { silence: true, newIssue: false } })

    const db = (store as unknown as { db: Parameters<typeof seedTraffic>[0] }).db

    // A day of history, ending three hours ago.
    await seedTraffic(db, Date.now() - 30 * HOUR, 3_000)
    await seedTraffic(db, Date.now() - 3 * HOUR, 3_000)

    // An empty flush — exactly what the timer does when nothing is happening.
    await store.flush()

    expect(sent.flatMap(reasonsOf)).toContain('silence')
  })

  it('stays quiet on a database with no history behind it', async () => {
    // The first window after installation. Alerting here would make the
    // product's first impression a false alarm.
    store = await open({ triggers: { silence: true, newIssue: false } })

    const db = (store as unknown as { db: Parameters<typeof seedTraffic>[0] }).db

    await seedTraffic(db, Date.now() - 3 * HOUR, 3_000)
    await store.flush()

    expect(sent.flatMap(reasonsOf)).not.toContain('silence')
  })

  it('stays quiet while events are still arriving', async () => {
    store = await open({ triggers: { silence: true, newIssue: false } })

    const db = (store as unknown as { db: Parameters<typeof seedTraffic>[0] }).db

    await seedTraffic(db, Date.now() - 30 * HOUR, 3_000)
    store.capture(makeEvent())
    await store.flush()

    expect(sent.flatMap(reasonsOf)).not.toContain('silence')
  })

  it('is off unless it is asked for', async () => {
    store = await open({ triggers: { newIssue: false } })

    const db = (store as unknown as { db: Parameters<typeof seedTraffic>[0] }).db

    await seedTraffic(db, Date.now() - 30 * HOUR, 3_000)
    await seedTraffic(db, Date.now() - 3 * HOUR, 3_000)
    await store.flush()

    expect(sent.flatMap(reasonsOf)).not.toContain('silence')
  })
})
