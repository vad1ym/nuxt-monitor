import { describe, expect, it, vi } from 'vitest'

/**
 * Reading a request through a reverse proxy.
 *
 * `#imports` is a Nuxt alias, so `getRequestHeader` is stubbed and the module
 * imported afterwards. What is exercised is the header arithmetic, which is
 * the whole of what these functions do.
 */

const headers: Record<string, string | undefined> = {}

vi.mock('#imports', () => ({
  getRequestHeader: (_event: unknown, name: string) => headers[name.toLowerCase()],
}))

const { clientAddress, isSameOrigin, requestHost } = await import('./proxy')

/** Stands in for an `H3Event`; only headers and the socket are ever read. */
function request(given: Record<string, string> = {}, remoteAddress?: string): never {
  for (const key of Object.keys(headers)) {
    delete headers[key]
  }

  for (const [name, value] of Object.entries(given)) {
    headers[name.toLowerCase()] = value
  }

  return { node: { req: { socket: { remoteAddress } } } } as never
}

describe('requestHost', () => {
  it('prefers the host the client addressed', () => {
    // A proxy sets `X-Forwarded-Host` precisely because it rewrote `Host`, so
    // when it is there it is the answer by definition.
    expect(requestHost(request({
      'host': 'localhost:3000',
      'x-forwarded-host': 'app.example.com',
    }))).toBe('app.example.com')
  })

  it('takes the leftmost of a chain', () => {
    expect(requestHost(request({ 'x-forwarded-host': 'app.example.com, inner.local' })))
      .toBe('app.example.com')
  })

  it('falls back to Host when nothing was forwarded', () => {
    expect(requestHost(request({ host: 'app.example.com' }))).toBe('app.example.com')
  })
})

describe('isSameOrigin', () => {
  it('accepts a report from the page behind a proxy', () => {
    // The failure this exists to prevent: comparing a public `Origin` against
    // an internal `Host` makes every genuine client error look cross-origin,
    // and the route drops it with a 204 — so an install behind nginx collects
    // server errors perfectly and quietly loses every browser one.
    expect(isSameOrigin(request({
      'origin': 'https://app.example.com',
      'host': 'localhost:3000',
      'x-forwarded-host': 'app.example.com',
    }))).toBe(true)
  })

  it('ignores the scheme, which a proxy routinely changes', () => {
    // The browser speaks https to the proxy and the proxy speaks http upstream.
    expect(isSameOrigin(request({
      'origin': 'https://app.example.com',
      'x-forwarded-host': 'app.example.com',
    }))).toBe(true)
  })

  it('still rejects a genuinely foreign origin', () => {
    expect(isSameOrigin(request({
      'origin': 'https://evil.example',
      'host': 'localhost:3000',
      'x-forwarded-host': 'app.example.com',
    }))).toBe(false)
  })

  it('accepts a request with no Origin at all', () => {
    // Several browsers omit it on same-origin requests, and `sendBeacon` is
    // among the inconsistent cases. Treating absence as hostile would drop
    // reports from the browsers that most need reporting.
    expect(isSameOrigin(request({ host: 'app.example.com' }))).toBe(true)
  })

  it('rejects an unparseable Origin', () => {
    expect(isSameOrigin(request({ origin: 'not a url', host: 'app.example.com' }))).toBe(false)
  })

  it('rejects when there is no host to compare against', () => {
    expect(isSameOrigin(request({ origin: 'https://app.example.com' }))).toBe(false)
  })

  it('compares the port, which is part of an origin', () => {
    expect(isSameOrigin(request({
      origin: 'https://app.example.com:8443',
      host: 'app.example.com',
    }))).toBe(false)
  })
})

describe('clientAddress', () => {
  it('takes the client from a forwarded chain', () => {
    // Without this every request arrives from the proxy's own address, and the
    // ingest rate limit becomes one shared bucket for the whole internet.
    expect(clientAddress(request({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })))
      .toBe('203.0.113.7')
  })

  it('falls back to X-Real-IP, then to the socket', () => {
    expect(clientAddress(request({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9')
    expect(clientAddress(request({}, '198.51.100.4'))).toBe('198.51.100.4')
  })

  it('answers something rather than nothing', () => {
    // The value is a rate-limit key; `undefined` would make every anonymous
    // request share one bucket by accident.
    expect(clientAddress(request({}))).toBe('unknown')
  })
})
