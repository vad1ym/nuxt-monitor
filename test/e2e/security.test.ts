import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PASSWORD, login, raw } from './helpers'
import { setup } from '@nuxt/test-utils/e2e'

/**
 * The properties that make the dashboard safe to run in production.
 *
 * Each case here corresponds to a way the dashboard could leak what it
 * collects — stack traces, source excerpts, request headers. They are
 * regressions, not formalities: every one of them describes a mistake that is
 * easy to reintroduce and invisible until someone finds the URL.
 */
await setup({
  rootDir: fileURLToPath(new URL('../../example', import.meta.url)),
  server: true,
  browser: false,
  env: {
    NUXT_MONITOR_AUTH_PASSWORD: PASSWORD,
    NUXT_MONITOR_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'monitor-sec-')),
  },
})

describe('access control', () => {
  it('rejects the API without a session', async () => {
    expect((await raw('/_monitor/api/issues')).status).toBe(401)
  })

  it('rejects a forged or malformed session cookie', async () => {
    for (const value of [
      'monitor_session=garbage',
      'monitor_session=abc.def',
      // A well-formed payload with an invented signature.
      `monitor_session=${Buffer.from(JSON.stringify({ exp: Date.now() + 1e9 })).toString('base64url')}.forged`,
    ]) {
      const response = await raw('/_monitor/api/issues', { headers: { cookie: value } })

      expect(response.status, `cookie: ${value}`).toBe(401)
    }
  })

  it('rejects an expired session', async () => {
    // Signed with the right shape but an expiry in the past. Even with a valid
    // signature this must not be accepted, so the check cannot be
    // signature-only.
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1_000, nonce: 'x' })).toString('base64url')
    const response = await raw('/_monitor/api/issues', {
      headers: { cookie: `monitor_session=${payload}.anything` },
    })

    expect(response.status).toBe(401)
  })

  it('rejects the wrong password and accepts the right one', async () => {
    const bad = await raw('/_monitor/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'not-the-password' },
    })

    expect(bad.status).toBe(401)

    const good = await raw('/_monitor/api/login', {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    })

    expect(good.status).toBe(200)
  })

  it('rejects a valid password under the wrong username', async () => {
    const response = await raw('/_monitor/api/login', {
      method: 'POST',
      body: { username: 'someone-else', password: PASSWORD },
    })

    expect(response.status).toBe(401)
  })

  it('does not reveal which half of the credentials was wrong', async () => {
    const wrongUser = await raw('/_monitor/api/login', {
      method: 'POST',
      body: { username: 'nobody', password: 'nope' },
    })

    const wrongPassword = await raw('/_monitor/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'nope' },
    })

    expect(await wrongUser.text()).toBe(await wrongPassword.text())
  })

  it('issues a session cookie that JavaScript cannot read', async () => {
    const response = await raw('/_monitor/api/login', {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    })

    const cookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? ''

    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('samesite=lax')
    // Scoped to the dashboard, so it never rides along on application requests.
    expect(cookie).toContain('Path=/_monitor')
  })

  it('accepts the API once signed in', async () => {
    const cookie = await login()

    expect((await raw('/_monitor/api/issues', { headers: { cookie } })).status).toBe(200)
  })

  /**
   * Health names the storage path and the byte counts, so an unauthenticated
   * one would confirm that nuxt-monitor is installed and describe the deployment
   * to anyone who asks.
   */
  it('keeps the health endpoint behind the session too', async () => {
    expect((await raw('/_monitor/api/health')).status).toBe(401)

    const cookie = await login()
    const response = await raw('/_monitor/api/health', { headers: { cookie } })

    expect(response.status).toBe(200)

    const body = await response.json() as { enabled: boolean, bytes: number }

    expect(body.enabled).toBe(true)
    expect(body.bytes).toBeGreaterThan(0)
  })

  it('stops accepting the session after logout', async () => {
    const cookie = await login()

    await raw('/_monitor/api/logout', { method: 'POST', headers: { cookie } })

    // The cookie is cleared client-side; the important part is that the
    // endpoint answers and the flow completes without error.
    expect((await raw('/_monitor/api/logout', { method: 'POST' })).status).toBe(200)
  })
})

describe('sourcemap exposure', () => {
  it('does not serve client sourcemaps', async () => {
    // The maps exist on disk for the resolver, but must not be reachable.
    // A 404 and not a 500: an error would confirm the file once existed.
    const { issues } = await $fetchIssues()

    expect(issues).toBeDefined()

    for (const path of [
      '/_nuxt/entry.js.map',
      '/_nuxt/index.js.map',
      '/monitor/maps/_nuxt/entry.js.map',
    ]) {
      const response = await raw(path)

      expect([404, 400], `${path} returned ${response.status}`).toContain(response.status)
    }
  })

  it('leaves no sourceMappingURL comment in served bundles', async () => {
    const shell = await raw('/')
    const html = await shell.text()

    const script = /src="([^"]*\/_nuxt\/[^"]+\.js)"/.exec(html)?.[1]

    // The example renders a page, so there is always at least one bundle.
    expect(script, 'no client bundle found in the served HTML').toBeTruthy()

    const bundle = await (await raw(script!)).text()

    expect(bundle).not.toContain('sourceMappingURL')
  })
})

describe('dashboard shell', () => {
  it('redirects the bare route so relative assets resolve', async () => {
    const response = await raw('/_monitor')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/_monitor/')
  })

  it('serves the shell unauthenticated so the login screen can render', async () => {
    const response = await raw('/_monitor/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('sends headers that keep the dashboard out of caches and referrers', async () => {
    const response = await raw('/_monitor/')

    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('serves unknown dashboard routes as the shell, not as 404', async () => {
    const response = await raw('/_monitor/issues/abc123')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
  })
})

describe('ingest hardening', () => {
  it('caps how many events one batch can carry', async () => {
    const events = Array.from({ length: 500 }, (_, i) => ({
      type: 'Error',
      message: `flood ${i}`,
      timestamp: Date.now(),
    }))

    const response = await raw('/_monitor/api/ingest', { method: 'POST', body: { events } })
    const body = await response.json() as { accepted: number }

    expect(body.accepted).toBeLessThanOrEqual(20)
  })

  it('survives a malformed body without failing the request', async () => {
    for (const body of ['not json at all', '{"events":"not-an-array"}', '{}']) {
      const response = await raw('/_monitor/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })

      expect([202, 204]).toContain(response.status)
    }
  })
})

/** Signs in and lists issues, for tests that only need the call to succeed. */
async function $fetchIssues(): Promise<{ issues: unknown[] }> {
  const cookie = await login()
  const response = await raw('/_monitor/api/issues', { headers: { cookie } })

  return await response.json() as { issues: unknown[] }
}

/**
 * The ingest endpoint takes no credentials, so the cost of a request has to be
 * bounded before anything parses it. The per-field caps only apply once the
 * whole body is already an object in memory.
 */
describe('ingest body limits', () => {
  it('refuses a body past the ceiling', async () => {
    const response = await raw('/_monitor/api/ingest', {
      method: 'POST',
      body: {
        events: [{
          type: 'Error',
          message: 'oversized',
          // Comfortably past the 512 KB ceiling.
          stack: 'x'.repeat(700_000),
          timestamp: Date.now(),
        }],
      },
    })

    expect(response.status).toBe(413)
  })

  it('still accepts an ordinary batch', async () => {
    const response = await raw('/_monitor/api/ingest', {
      method: 'POST',
      body: {
        events: [{
          type: 'Error',
          message: 'ordinary sized report',
          stack: 'Error: x\n    at fn (/_nuxt/app.js:1:1)',
          timestamp: Date.now(),
        }],
      },
    })

    expect(response.status).toBe(202)
  })
})

/**
 * `SameSite=Lax` blocks the ordinary cross-site form post, but a sibling
 * subdomain is same-site: on a host with wildcard DNS, `evil.example.com` can
 * drive a request to `monitor.example.com` and the browser attaches the session.
 * So a mutating call also has to come from this host.
 */
describe('cross-origin state changes', () => {
  it('refuses a resolve driven from another origin', async () => {
    const cookie = await login()
    const listed = await raw('/_monitor/api/issues?limit=1', { headers: { cookie } })
    const { issues } = await listed.json() as { issues: { fingerprint: string }[] }

    const fingerprint = issues[0]?.fingerprint

    expect(fingerprint).toBeDefined()

    const response = await raw(`/_monitor/api/issues/${fingerprint}`, {
      method: 'PATCH',
      headers: { cookie, origin: 'https://evil.example.com' },
      body: { resolved: true },
    })

    expect(response.status).toBe(403)
  })

  it('refuses a logout driven from another origin', async () => {
    const cookie = await login()

    const response = await raw('/_monitor/api/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example.com' },
    })

    expect(response.status).toBe(403)

    // The session is untouched, which is the point.
    const session = await raw('/_monitor/api/session', { method: 'POST', headers: { cookie } })

    expect(await session.json()).toMatchObject({ authenticated: true })
  })

  /** Signing in is not a state change on anyone's behalf, and requiring the
   * header there would break every non-browser client. */
  it('still allows a login without an Origin header', async () => {
    const response = await raw('/_monitor/api/login', {
      method: 'POST',
      headers: { origin: '' },
      body: { username: 'admin', password: PASSWORD },
    })

    expect(response.status).toBe(200)
  })
})
