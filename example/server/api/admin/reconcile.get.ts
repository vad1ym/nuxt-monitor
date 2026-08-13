import { CATALOG, ORDERS } from '../../utils/shop'

/**
 * The nightly job, run on demand.
 *
 * Two reports from one handler, in two different groups, so the dashboard has
 * something to filter and the notification routing has two names to route on.
 * Neither of them is an exception in the language sense: the job finishes, the
 * response is 200, and the only reason anybody finds out is that somebody
 * wrote the branch down.
 */
export default defineEventHandler((event) => {
  const sold = [...ORDERS.values()]
    .flatMap(order => order.lines)
    .reduce((sum, line) => sum + line.quantity, 0)

  // Stock that went out without a matching order line. In a real shop this is
  // shrinkage, a bad import, or a bug in the picking service — worth a look,
  // not worth a phone call, so: `warning`.
  const ledger = CATALOG.reduce((sum, product) => sum + product.stock, 0)

  exception('Inventory count drifted from the ledger', {
    level: 'warning',
    group: 'data-integrity',
    meta: { ledger, sold, drift: sold - ledger },
  }, event)

  const unbalanced = [...ORDERS.values()].filter(order => order.charged !== order.total)

  if (unbalanced.length) {
    exception('Orders settled for less than their total', {
      level: 'critical',
      group: 'payments',
      meta: {
        orders: unbalanced.length,
        shortfall: unbalanced.reduce((sum, order) => sum + (order.total - order.charged), 0),
      },
    }, event)
  }

  return { checked: ORDERS.size, unbalanced: unbalanced.length }
})
