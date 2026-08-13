import { describe, expect, it } from 'vitest'
import { bucketOf, isAssetPath, normalizeRoute, routeKind, statusClass } from './route'

describe('normalizeRoute', () => {
  it('collapses numeric ids so one endpoint is one row', () => {
    // The whole point: without this, every id in production becomes its own
    // counter row and the table grows with traffic.
    expect(normalizeRoute('/users/1')).toBe('/users/:id')
    expect(normalizeRoute('/users/1')).toBe(normalizeRoute('/users/99999'))
  })

  it('collapses uuids and long hashes', () => {
    expect(normalizeRoute('/orders/550e8400-e29b-41d4-a716-446655440000')).toBe('/orders/:uuid')
    expect(normalizeRoute('/files/507f1f77bcf86cd799439011')).toBe('/files/:hash')
  })

  it('collapses slugs that end in an id', () => {
    expect(normalizeRoute('/posts/hello-world-1234')).toBe('/posts/:slug')
  })

  it('keeps the parts that describe the route', () => {
    expect(normalizeRoute('/api/orders')).toBe('/api/orders')
    expect(normalizeRoute('/api/orders/1/items')).toBe('/api/orders/:id/items')
  })

  it('drops the query string, which is per-request detail', () => {
    expect(normalizeRoute('/search?q=shoes&page=2')).toBe('/search')
  })

  it('normalises the root and empty input', () => {
    expect(normalizeRoute('/')).toBe('/')
    expect(normalizeRoute('')).toBe('/')
    expect(normalizeRoute(undefined)).toBe('/')
  })

  it('hides build hashes in asset paths but keeps the extension', () => {
    expect(normalizeRoute('/_nuxt/entry.C2V2OSOE.js'))
      .toBe(normalizeRoute('/_nuxt/entry.6A6825Cy.js'))

    expect(normalizeRoute('/_nuxt/entry.C2V2OSOE.js')).toContain('.js')
  })

  it('collapses long opaque segments', () => {
    // Not hex, so it falls through to the length rule rather than `:hash`.
    const token = 'zx'.repeat(32)

    expect(normalizeRoute(`/callback/${token}`)).toBe('/callback/:value')
  })

  it('bounds the depth of pathological paths', () => {
    const deep = `/${Array.from({ length: 40 }, (_, i) => `s${i}`).join('/')}`

    expect(normalizeRoute(deep).endsWith('/*')).toBe(true)
    expect(normalizeRoute(deep).split('/').length).toBeLessThan(16)
  })

  it('bounds the length of the key', () => {
    expect(normalizeRoute(`/${'x'.repeat(1_000)}`).length).toBeLessThan(250)
  })
})

describe('statusClass', () => {
  it('groups statuses into classes', () => {
    expect(statusClass(200)).toBe('2xx')
    expect(statusClass(304)).toBe('3xx')
    expect(statusClass(404)).toBe('4xx')
    expect(statusClass(500)).toBe('5xx')
  })

  it('reports anything outside the valid range as unknown', () => {
    expect(statusClass(0)).toBe('unknown')
    expect(statusClass(999)).toBe('unknown')
    expect(statusClass(Number.NaN)).toBe('unknown')
  })
})

describe('isAssetPath', () => {
  /**
   * The reason this exists: a page view drags dozens of chunks in with it, and
   * counting them buried the real endpoints in a table ranked by failure rate
   * while diluting the denominator every rate is divided by.
   */
  it('recognises the build output', () => {
    expect(isAssetPath('/_nuxt/Cn7cGL6M.js')).toBe(true)
    expect(isAssetPath('/_nuxt/builds/meta/2627dd60.json')).toBe(true)
    expect(isAssetPath('/_nuxt/error-500.CZqNkBuR.css')).toBe(true)
  })

  it('recognises files served from anywhere else', () => {
    expect(isAssetPath('/favicon.ico')).toBe(true)
    expect(isAssetPath('/images/logo.svg')).toBe(true)
    expect(isAssetPath('/robots.txt')).toBe(true)
  })

  it('leaves application endpoints alone', () => {
    expect(isAssetPath('/api/checkout')).toBe(false)
    expect(isAssetPath('/users/42')).toBe(false)
    expect(isAssetPath('/')).toBe(false)
    expect(isAssetPath(undefined)).toBe(false)
  })

  /**
   * A dot in a path segment is not automatically an extension — only a
   * trailing one is. `/api/v1.2/orders` is an endpoint.
   */
  it('judges by the last segment, not by any dot in the path', () => {
    expect(isAssetPath('/api/v1.2/orders')).toBe(false)
    expect(isAssetPath('/download/report.pdf?token=x')).toBe(true)
  })
})

describe('bucketOf', () => {
  it('floors a timestamp to the start of its bucket', () => {
    const minute = 60_000

    expect(bucketOf(1_000_000_061_234, minute)).toBe(1_000_000_020_000)
  })

  it('puts timestamps in the same window into the same bucket', () => {
    const minute = 60_000
    // Aligned to a bucket boundary, so the offsets below stay inside one window.
    const base = bucketOf(1_700_000_000_000, minute)

    expect(bucketOf(base + 1_000, minute)).toBe(bucketOf(base + 59_000, minute))
    expect(bucketOf(base + 1_000, minute)).not.toBe(bucketOf(base + 61_000, minute))
  })
})

describe('routeKind', () => {
  it('calls the convention an endpoint', () => {
    expect(routeKind('/api/orders')).toBe('api')
    expect(routeKind('/api/orders/42?x=1')).toBe('api')
    expect(routeKind('/graphql')).toBe('api')
  })

  it('calls a page a page', () => {
    expect(routeKind('/checkout')).toBe('page')
    expect(routeKind('/')).toBe('page')
  })

  it('keeps assets out of both', () => {
    // A missing image is not an endpoint failure and not a page failure.
    expect(routeKind('/logo.svg')).toBe('asset')
    expect(routeKind('/_nuxt/entry.abc123.js')).toBe('asset')
  })

  it('trusts the Accept header over the path', () => {
    // The point of reading the header: an application that mounts endpoints
    // somewhere other than `/api` still gets them classified correctly.
    expect(routeKind('/orders', 'application/json')).toBe('api')
    expect(routeKind('/orders', 'text/html,application/xhtml+xml')).toBe('page')
  })

  it('treats a path with no header as a page', () => {
    // The common case for a client-side error, where the only thing known is
    // the URL of the page it happened on.
    expect(routeKind('/checkout', undefined)).toBe('page')
  })

  it('does not let the header override an obvious endpoint', () => {
    // A browser navigating straight to an API URL is still an API failure.
    expect(routeKind('/api/orders', 'text/html')).toBe('api')
  })
})
