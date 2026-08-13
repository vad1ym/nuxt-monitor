/**
 * A request that succeeds while something is wrong.
 *
 * The case `exception()` exists for: the handler has a branch for the bad
 * outcome, returns a perfectly good 200, and nothing about the response says
 * that the totals did not add up. Without a deliberate report this is invisible
 * to a tool that watches for throws.
 */
export default defineEventHandler((event) => {
  const order = { id: 4821, total: 5990 }
  const charged = 5490

  if (charged !== order.total) {
    exception('Charged total does not match the order', {
      // Somebody is short 5 euros and nothing failed. That is worth waking
      // someone for, and the level is how the call site says so.
      level: 'critical',
      group: 'payments',
      meta: { order: order.id, expected: order.total, charged },
      // Passing the event attaches the route and the method, which is the
      // difference between "totals disagree" and "totals disagree on
      // GET /api/reconcile".
    }, event)
  }

  // Two groups from one handler, so the dashboard has something to filter.
  exception('Inventory count drifted from the ledger', {
    level: 'warning',
    group: 'data-integrity',
    meta: { sku: 'AB-12', drift: -3 },
  }, event)

  return { ok: true, order: order.id }
})
