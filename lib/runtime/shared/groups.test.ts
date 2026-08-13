import { describe, expect, it } from 'vitest'
import { compileGroups, findGroup, groupFor } from './groups'

const groups = compileGroups({
  payments: { routes: ['/api/checkout/**', '/api/refunds/**'], notify: true },
  'third-party': { messages: ['stripe', '/timeout of \\d+ms/'] },
  admin: { routes: ['/admin/**'] },
  search: ['/api/search'],
})

describe('matching by route', () => {
  it('claims the paths a rule names', () => {
    expect(groupFor(groups, { route: '/api/checkout' })?.name).toBe('payments')
    expect(groupFor(groups, { route: '/api/checkout/confirm' })?.name).toBe('payments')
    expect(groupFor(groups, { route: '/admin/users/42' })?.name).toBe('admin')
  })

  it('claims nothing else', () => {
    expect(groupFor(groups, { route: '/api/orders' })).toBeUndefined()
    expect(groupFor(groups, { route: '/' })).toBeUndefined()
  })

  it('anchors the pattern at both ends', () => {
    // Substring matching would file `/internal/api-docs` under an `/api` rule,
    // and an issue quietly assigned to the wrong team is worse than one with
    // no team at all.
    expect(groupFor(compileGroups({ api: ['/api'] }), { route: '/internal/api-docs' }))
      .toBeUndefined()
  })

  it('ignores the query string', () => {
    expect(groupFor(groups, { route: '/api/search?q=shoes' })?.name).toBe('search')
  })

  it('takes a bare array as a list of routes', () => {
    // The common case is a group that is only paths, and making it write
    // `{ routes: [...] }` is ceremony for nothing.
    expect(groupFor(groups, { route: '/api/search' })?.name).toBe('search')
  })

  it('treats `*` as one segment and `**` as many', () => {
    const one = compileGroups({ a: ['/api/*'] })

    expect(groupFor(one, { route: '/api/orders' })?.name).toBe('a')
    expect(groupFor(one, { route: '/api/orders/42' })).toBeUndefined()

    const many = compileGroups({ b: ['/api/**'] })

    expect(groupFor(many, { route: '/api/orders/42' })?.name).toBe('b')
  })

  it('lets a trailing `/**` cover the section root too', () => {
    // `/api/checkout/**` and `/api/checkout` — nobody writing the first means
    // "all of checkout except checkout itself", and getting this wrong files
    // the most obvious route in the group under no group at all.
    const rules = compileGroups({ payments: ['/api/checkout/**'] })

    expect(groupFor(rules, { route: '/api/checkout' })?.name).toBe('payments')
    expect(groupFor(rules, { route: '/api/checkout/confirm' })?.name).toBe('payments')
    // Still a boundary, not a prefix.
    expect(groupFor(rules, { route: '/api/checkout-legacy' })).toBeUndefined()
  })

  it('matches `:param` as a single segment', () => {
    const rules = compileGroups({ orders: ['/api/orders/:id'] })

    expect(groupFor(rules, { route: '/api/orders/42' })?.name).toBe('orders')
    expect(groupFor(rules, { route: '/api/orders/42/items' })).toBeUndefined()
  })

  it('does not let a dot in a pattern match any character', () => {
    const rules = compileGroups({ assets: ['/logo.svg'] })

    expect(groupFor(rules, { route: '/logoXsvg' })).toBeUndefined()
    expect(groupFor(rules, { route: '/logo.svg' })?.name).toBe('assets')
  })
})

describe('matching by message', () => {
  it('finds the fault a path cannot', () => {
    // A provider breaks inside your route, not on its own.
    expect(groupFor(groups, { route: '/api/orders', message: 'Stripe refused the charge' })?.name)
      .toBe('third-party')
  })

  it('takes a /regex/ the same way `ignore` does', () => {
    expect(groupFor(groups, { message: 'timeout of 5000ms exceeded' })?.name).toBe('third-party')
  })

  it('is case-insensitive for substrings', () => {
    expect(groupFor(groups, { message: 'STRIPE is down' })?.name).toBe('third-party')
  })
})

describe('precedence', () => {
  it('takes the first rule declared, not the most specific', () => {
    // Declaration order is something the reader can see; "most specific" asks
    // them to hold a specificity algorithm in their head to predict this.
    const rules = compileGroups({
      broad: ['/api/**'],
      narrow: ['/api/checkout'],
    })

    expect(groupFor(rules, { route: '/api/checkout' })?.name).toBe('broad')
  })

  it('prefers a route match to a message match within one rule', () => {
    // Both are checked per group in order, so a group listed earlier wins
    // whichever of its two lists matched.
    const rules = compileGroups({
      byPath: { routes: ['/api/checkout'] },
      byText: { messages: ['checkout'] },
    })

    expect(groupFor(rules, { route: '/api/checkout', message: 'checkout failed' })?.name)
      .toBe('byPath')
  })
})

describe('notify', () => {
  it('is off unless asked for', () => {
    expect(findGroup(groups, 'payments')?.notify).toBe(true)
    expect(findGroup(groups, 'admin')?.notify).toBe(false)
  })
})

describe('no rules at all', () => {
  it('assigns nothing and costs nothing', () => {
    expect(compileGroups(undefined)).toEqual([])
    expect(groupFor([], { route: '/api/checkout' })).toBeUndefined()
  })
})
