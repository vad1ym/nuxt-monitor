import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $fetch, setup, url } from '@nuxt/test-utils/e2e'
import { beforeAll, describe, expect, it } from 'vitest'
import { PASSWORD, login, raw, waitForIssue } from './helpers'

/**
 * Collection, exercised against a running Nuxt app.
 *
 * Every case here is a distinct path into the collector — a handler throw, a
 * `createError`, an async rejection, server middleware, and an SSR render
 * failure all reach it differently. Unit tests cannot tell whether the hooks
 * are wired to the right places; only a real request can.
 */
await setup({
  rootDir: fileURLToPath(new URL('../../example', import.meta.url)),
  server: true,
  browser: false,
  env: {
    // Set through `runtimeConfig`'s own env override rather than the
    // build-time variable, so the credential is applied when the server boots
    // and the test does not depend on how the example happened to be built.
    NUXT_MONITOR_AUTH_PASSWORD: PASSWORD,
    // A fresh database per run. Sharing the example's `.monitor` would carry
    // issues over from previous runs and from manual use, so assertions about
    // how many issues exist would depend on what happened earlier.
    NUXT_MONITOR_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'monitor-e2e-')),
    // The example bakes in a release from its `.env`, and the server rightly
    // overrides whatever a client claims — a browser must not be able to
    // invent release names. Cleared here so the release tests can supply their
    // own, which is the only way to exercise more than one.
    NUXT_MONITOR_RELEASE: '',
  },
})

let cookie: string

beforeAll(async () => {
  cookie = await login()
})

/** Triggers a route and ignores the failure it is supposed to produce. */
async function trigger(path: string, options: Record<string, unknown> = {}): Promise<void> {
  await $fetch(path, { ...options, ignoreResponseError: true } as never).catch(() => {})
}

describe('server collection', () => {
  it('captures a plain throw in a route handler', async () => {
    await trigger('/api/catalog/cable-tray')

    const issue = await waitForIssue(cookie, i => i.message.includes('reading \'width\''))

    expect(issue.side).toBe('server')
    expect(issue.type).toBe('TypeError')
  })

  it('captures createError with its status code and both bodies', async () => {
    await trigger('/api/checkout/quote', {
      method: 'POST',
      body: { lines: [{ slug: 'discontinued-rug', quantity: 1 }], password: 'hunter2' },
    })

    const issue = await waitForIssue(cookie, i => i.message.includes('no longer in the catalogue'))
    const detail = await $fetch<{ events: { context?: Record<string, unknown> }[] }>(
      `/_monitor/api/issues/${issue.fingerprint}`,
      { headers: { cookie } },
    )

    const context = detail.events[0]?.context

    expect(context?.statusCode).toBe(500)
    expect(context?.method).toBe('POST')
    expect(context?.url).toBe('/api/checkout/quote')

    // What came back — `createError({ data })` is the body the client is about
    // to receive, and it survives as the response half.
    expect((context?.responseBody as Record<string, unknown>)?.slug).toBe('discontinued-rug')

    // What was sent. The example turns this half on, which is what makes
    // "which product" answerable at all — and the password that rode along
    // with it must not have survived the trip.
    const sent = context?.requestBody as Record<string, unknown>

    expect((sent?.lines as { slug: string }[])?.[0]?.slug).toBe('discontinued-rug')
    expect(JSON.stringify(sent)).not.toContain('hunter2')
  })

  it('ignores 4xx, which are client mistakes rather than application faults', async () => {
    await trigger('/api/catalog/no-such-product')

    // Give collection the same chance it gets everywhere else, then assert it
    // did *not* record anything — 404s would otherwise bury the real errors.
    await new Promise(resolve => setTimeout(resolve, 1_500))

    const { issues } = await $fetch<{ issues: { message: string }[] }>('/_monitor/api/issues?limit=100', {
      headers: { cookie },
    })

    expect(issues.some(i => i.message.includes('No product named'))).toBe(false)
  })

  it('records where the error happened, for the list to show', async () => {
    await trigger('/api/admin/report')

    const issue = await waitForIssue(cookie, i => i.message.includes('timed out after'))

    // Enough to know where to look without opening the issue — and not a
    // framework file, which would be the same unhelpful answer every time.
    expect(issue.culprit).toMatch(/report/)
    expect(issue.culprit).not.toMatch(/nitro|node_modules/)
    expect(issue.route).toBe('/api/admin/report')
    expect(issue.method).toBe('GET')
  })

  it('captures a rejection from an awaited call', async () => {
    await trigger('/api/admin/report')

    const issue = await waitForIssue(cookie, i => i.message.includes('timed out after'))

    expect(issue.side).toBe('server')
  })

  it('captures a failure in server middleware', async () => {
    await trigger('/api/admin/bulk')

    const issue = await waitForIssue(cookie, i => i.message.includes('reading \'remaining\''))

    expect(issue.side).toBe('server')
  })

  /**
   * Server frames have to name the user's file, and two settings have to hold
   * for that: `sourcemap.server`, and Nitro's `sourcemapMinify` being off.
   * Both fail silently — the `.map` is still written and still lists the right
   * source, it just resolves every position to null — so the symptom is a
   * trace pointing at `nitro.mjs` while the answer sits in the map beside it.
   */
  it('resolves a server frame to the source file it came from', async () => {
    await trigger('/api/admin/bulk')

    const issue = await waitForIssue(cookie, i => i.message.includes('reading \'remaining\''))

    const detail = await $fetch<{
      events: { frames: { original?: { file: string, line: number } }[] }[]
    }>(`/_monitor/api/issues/${issue.fingerprint}`, { headers: { cookie } })

    const resolved = detail.events[0]?.frames
      .map(frame => frame.original)
      .find(original => original?.file.includes('middleware/rate-limit'))

    expect(resolved).toBeDefined()
    // The quota read, not the handler wrapping it.
    expect(resolved!.line).toBe(20)
  })

  it('captures an SSR render failure exactly once', async () => {
    await trigger('/admin')

    const issue = await waitForIssue(cookie, i => i.message.includes('reading \'permissions\''))

    // Nuxt reports this through `vue:error` and it also propagates to Nitro.
    // Both arrivals must collapse into one issue, and the real constructor
    // name has to survive h3's wrapping.
    expect(issue.type).toBe('TypeError')

    const { issues } = await $fetch<{ issues: { message: string }[] }>('/_monitor/api/issues?limit=100', {
      headers: { cookie },
    })

    const matching = issues.filter(i => i.message.includes('reading \'permissions\''))

    expect(matching).toHaveLength(1)
  })

  it('counts repeats of one fault as a single issue', async () => {
    const before = await waitForIssue(cookie, i => i.message.includes('timed out after'))

    await trigger('/api/admin/report')
    await trigger('/api/admin/report')

    const after = await waitForIssue(
      cookie,
      i => i.message.includes('timed out after') && i.count > before.count,
    )

    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after.count).toBeGreaterThanOrEqual(before.count + 2)
  })
})

describe('redaction', () => {
  it('never stores credentials from headers, query or payload', async () => {
    await trigger('/api/admin/export?token=leaked-token-value', {
      headers: {
        authorization: 'Bearer super-secret-token',
        cookie: 'session=very-secret-session',
      },
    })

    const issue = await waitForIssue(cookie, i => i.message.includes('could not reach the warehouse'))
    const detail = await $fetch<{ events: { context?: Record<string, unknown> }[] }>(
      `/_monitor/api/issues/${issue.fingerprint}`,
      { headers: { cookie } },
    )

    const serialized = JSON.stringify(detail.events[0]?.context ?? {})

    // The specific secrets sent above must not appear anywhere in the record.
    expect(serialized).not.toContain('super-secret-token')
    expect(serialized).not.toContain('very-secret-session')
    expect(serialized).not.toContain('leaked-token-value')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('sk-live-should-never-be-stored')

    // …while the parts worth keeping are still there.
    expect(serialized).toContain('this one should survive')
    expect(serialized).toContain('[redacted]')
  })
})

describe('client intake', () => {
  it('accepts a batch posted by the browser collector', async () => {
    const response = await $fetch<{ accepted: number }>('/_monitor/api/ingest', {
      method: 'POST',
      body: {
        events: [{
          type: 'ReferenceError',
          message: 'browser reported this',
          stack: 'ReferenceError: browser reported this\n    at fn (/_nuxt/app.js:1:1)',
          timestamp: Date.now(),
          context: { url: '/somewhere?token=secret-in-url' },
        }],
      },
    })

    expect(response.accepted).toBe(1)

    const issue = await waitForIssue(cookie, i => i.message === 'browser reported this')

    expect(issue.side).toBe('client')
    expect(issue.type).toBe('ReferenceError')

    const detail = await $fetch<{ events: { context?: Record<string, unknown> }[] }>(
      `/_monitor/api/issues/${issue.fingerprint}`,
      { headers: { cookie } },
    )

    // Client-supplied URLs go through the same redaction as server ones.
    expect(JSON.stringify(detail.events[0]?.context)).not.toContain('secret-in-url')
  })

  it('keeps a breadcrumb trail readable', async () => {
    // What led up to the error is most of what makes a browser error
    // diagnosable, and it is only useful if a person can read it. Every
    // message used to go through the URL scrubber, which accepted
    // `POST /api/x → 500` as a relative path and percent-encoded the whole
    // sentence — technically scrubbed, and unreadable.
    await $fetch('/_monitor/api/ingest', {
      method: 'POST',
      body: {
        events: [{
          type: 'TypeError',
          message: 'trail check',
          timestamp: Date.now(),
          context: { url: '/cart' },
          breadcrumbs: [
            { type: 'navigation', timestamp: Date.now(), message: '/cart?token=secret-in-crumb' },
            { type: 'click', timestamp: Date.now(), message: 'Price the basket' },
            { type: 'fetch', timestamp: Date.now(), message: 'POST /api/checkout/quote → 500' },
          ],
        }],
      },
    })

    const issue = await waitForIssue(cookie, i => i.message === 'trail check')
    const detail = await $fetch<{ events: { breadcrumbs?: { type: string, message: string }[] }[] }>(
      `/_monitor/api/issues/${issue.fingerprint}`,
      { headers: { cookie } },
    )

    const trail = detail.events[0]?.breadcrumbs ?? []

    expect(trail.find(crumb => crumb.type === 'fetch')?.message)
      .toBe('POST /api/checkout/quote → 500')
    expect(trail.find(crumb => crumb.type === 'click')?.message).toBe('Price the basket')

    // A navigation crumb *is* a URL, so it still gets the URL treatment.
    const navigation = trail.find(crumb => crumb.type === 'navigation')?.message

    expect(navigation).toContain('/cart')
    expect(navigation).not.toContain('secret-in-crumb')
  })

  it('rejects entries that are not shaped like events', async () => {
    const response = await $fetch<{ accepted: number }>('/_monitor/api/ingest', {
      method: 'POST',
      body: { events: [{ nonsense: true }, null, 'string', { message: '' }] },
    })

    expect(response.accepted).toBe(0)
  })

  it('ignores a batch posted from another origin', async () => {
    const response = await raw('/_monitor/api/ingest', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
      body: { events: [{ type: 'Error', message: 'cross-origin injection', timestamp: Date.now() }] },
    })

    expect(response.status).toBe(204)

    const { issues } = await $fetch<{ issues: { message: string }[] }>('/_monitor/api/issues?limit=100', {
      headers: { cookie },
    })

    expect(issues.some(i => i.message === 'cross-origin injection')).toBe(false)
  })
})

describe('issue management', () => {
  it('resolves and reopens an issue', async () => {
    const issue = await waitForIssue(cookie, i => i.message.includes('reading \'remaining\''))

    const resolved = await $fetch<{ resolved: boolean }>(`/_monitor/api/issues/${issue.fingerprint}`, {
      method: 'PATCH',
      // A mutating call checks `Origin`, which the dashboard's browser always
      // sends. The check itself is covered in the security suite.
      headers: { cookie, origin: new URL(url('/')).origin },
      body: { resolved: true },
    })

    expect(resolved.resolved).toBe(true)

    // A resolved issue that happens again is open again.
    await trigger('/api/admin/bulk')

    const reopened = await waitForIssue(
      cookie,
      i => i.fingerprint === issue.fingerprint && !i.resolved,
      { resolved: false },
    )

    expect(reopened.resolved).toBe(false)
  })

  it('filters by side', async () => {
    const { issues } = await $fetch<{ issues: { side: string }[] }>('/_monitor/api/issues?side=server&limit=100', {
      headers: { cookie },
    })

    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every(i => i.side === 'server')).toBe(true)
  })

  it('reports 404 for an unknown fingerprint', async () => {
    const response = await raw('/_monitor/api/issues/deadbeef', { headers: { cookie } })

    expect(response.status).toBe(404)
  })
})

/**
 * Facets, end to end.
 *
 * The parsing has unit tests; what only a real request can show is that the
 * `User-Agent` reaches the parser, that the columns are written, and that the
 * breakdown and the filter agree with each other.
 */
describe('facets', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1'

  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

  /** Posts one client error as a given browser and session. */
  async function report(message: string, agent: string, session: string): Promise<void> {
    await $fetch('/_monitor/api/ingest', {
      method: 'POST',
      headers: { 'user-agent': agent },
      body: {
        events: [{
          type: 'Error',
          message,
          stack: `Error: ${message}\n    at fn (/_nuxt/app.js:1:1)`,
          timestamp: Date.now(),
          facets: { session },
        }],
      },
    })
  }

  it('derives browser and OS from the request, and counts sessions', async () => {
    const message = 'facet subject'

    // Three events, two sessions, two browsers.
    await report(message, IPHONE, 'session-a')
    await report(message, IPHONE, 'session-a')
    await report(message, CHROME, 'session-b')

    const issue = await waitForIssue(cookie, i => i.message === message)

    const detail = await $fetch<{
      facets: Record<string, { values: { value: string, count: number }[] }>
      sessionCount: number
    }>(`/_monitor/api/issues/${issue.fingerprint}`, { headers: { cookie } })

    expect(detail.facets.os.values).toContainEqual(expect.objectContaining({ value: 'iOS', count: 2 }))
    expect(detail.facets.browser.values).toContainEqual(
      expect.objectContaining({ value: 'Chrome', count: 1 }),
    )
    expect(detail.facets.deviceType.values).toContainEqual(
      expect.objectContaining({ value: 'mobile', count: 2 }),
    )

    // Three occurrences, but only two people.
    expect(issue.count).toBe(3)
    expect(detail.sessionCount).toBe(2)
  })

  it('filters the occurrences of an issue down to one slice', async () => {
    const message = 'facet filter subject'

    await report(message, IPHONE, 'session-c')
    await report(message, CHROME, 'session-d')

    const issue = await waitForIssue(cookie, i => i.message === message)

    const filtered = await $fetch<{
      events: unknown[]
      sessionCount: number
      eventCount: number
    }>(`/_monitor/api/issues/${issue.fingerprint}?os=iOS`, { headers: { cookie } })

    expect(filtered.events).toHaveLength(1)
    expect(filtered.sessionCount).toBe(1)
    // The breakdown has to add up to the number shown beside it.
    expect(filtered.eventCount).toBe(1)
  })

  it('narrows the issue list to issues seen on a given facet', async () => {
    const { issues } = await $fetch<{ issues: { message: string }[] }>(
      '/_monitor/api/issues?limit=100&browser=Mobile%20Safari',
      { headers: { cookie } },
    )

    const messages = issues.map(i => i.message)

    expect(messages).toContain('facet subject')
    // Server errors in this suite were triggered without an iPhone agent.
    expect(messages).not.toContain('Server middleware rejected the request')
  })

  it('serves facet counts across the window', async () => {
    const { facets } = await $fetch<{ facets: Record<string, { values: { value: string }[] }> }>(
      '/_monitor/api/facets',
      { headers: { cookie } },
    )

    expect(facets.browser.values.map(row => row.value)).toContain('Mobile Safari')
    // Facets are a dashboard read, so they must sit behind the session.
    expect((await raw('/_monitor/api/facets')).status).toBe(401)
  })
})

/**
 * The standalone sections.
 *
 * The interesting one is `newIssues`: an issue already present in an earlier
 * release is not something a later one introduced, however often it happens
 * there now. That distinction is the whole point of the releases screen, and
 * it is the kind of thing a unit test over a hand-built table would not catch
 * — it depends on events arriving through the real ingest path.
 */
describe('stats sections', () => {
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

  async function report(message: string, release: string, session: string): Promise<void> {
    await $fetch('/_monitor/api/ingest', {
      method: 'POST',
      headers: { 'user-agent': CHROME },
      body: {
        events: [{
          type: 'Error',
          message,
          stack: `Error: ${message}\n    at fn (/_nuxt/app.js:1:1)`,
          timestamp: Date.now(),
          facets: { session, release },
        }],
      },
    })
  }

  it('credits an issue to the release it first appeared in', async () => {
    // Same fault in both releases, plus one only the later release has.
    await report('inherited across releases', '9.0.0', 's1')
    await report('inherited across releases', '9.1.0', 's2')
    await report('introduced later', '9.1.0', 's3')

    await waitForIssue(cookie, i => i.message === 'introduced later')

    const { releases } = await $fetch<{
      releases: { release: string, issues: number, newIssues: number, sessions: number }[]
    }>('/_monitor/api/stats?section=releases', { headers: { cookie } })

    const first = releases.find(r => r.release === '9.0.0')!
    const second = releases.find(r => r.release === '9.1.0')!

    expect(first.newIssues).toBe(1)

    // Two issues present, but only one of them started here.
    expect(second.issues).toBe(2)
    expect(second.newIssues).toBe(1)
  })

  it('reports routes, environments and sessions over the window', async () => {
    const stats = await $fetch<{
      routes: { route: string, total: number }[]
      environments: Record<string, { values: unknown[] }>
      sessions: { affected: number, events: number }
    }>('/_monitor/api/stats', { headers: { cookie } })

    expect(stats.routes.length).toBeGreaterThan(0)
    expect(stats.environments.browser.values.length).toBeGreaterThan(0)
    expect(stats.sessions.affected).toBeGreaterThan(0)
  })

  it('sits behind the session like every other dashboard read', async () => {
    expect((await raw('/_monitor/api/stats')).status).toBe(401)
  })
})
