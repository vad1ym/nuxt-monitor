import { ORDERS, formatPrice } from '../../utils/shop'

/**
 * Confirms an order, and answers 200 whether or not the books balance.
 *
 * This is the case `exception()` exists for, and it is worth being precise
 * about why. The handler *has* a branch for the bad outcome. It takes it. It
 * then returns a perfectly good response, because from the customer's point of
 * view the order is placed and there is nothing to show them. Nothing throws,
 * no status code is unusual, and a tool that watches for failures sees a
 * healthy endpoint — while somebody is short five euros on every multi-line
 * order in the shop.
 *
 * `critical` rather than `error`: money that does not add up is the one thing
 * here worth waking somebody for, and the level is how the call site says so.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ orderId?: string }>(event)
  const order = ORDERS.get(body?.orderId ?? '')

  if (!order) {
    throw createError({ statusCode: 404, statusMessage: 'No such order' })
  }

  if (order.charged !== order.total) {
    exception('Charged total does not match the order', {
      level: 'critical',
      group: 'payments',
      meta: {
        order: order.id,
        expected: formatPrice(order.total),
        charged: formatPrice(order.charged),
        shortfall: formatPrice(order.total - order.charged),
        lines: order.lines.length,
      },
      // Passing the event attaches the route and the method, which is the
      // difference between "totals disagree" and "totals disagree on
      // POST /api/checkout/confirm".
    }, event)
  }

  return { orderId: order.id, status: 'confirmed' as const }
})
