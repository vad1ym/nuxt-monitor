import { ORDERS, nextOrderId, totalFor } from '../../utils/shop'
import type { OrderLine } from '../../utils/shop'

/**
 * Takes the money, or fails to.
 *
 * The failure here is the one that matters most in the whole example: the
 * payment provider is down. It is not our code that broke, the stack points
 * into a fetch, and the message carries the provider's name — which is what
 * the `third-party` group rule matches on. A monitor that cannot separate
 * "we broke" from "Stripe broke" sends the wrong person out of bed.
 *
 * The request also carries a card token in its headers, which must never
 * reach the database. Scrubbing is not a feature you check once; it is the
 * reason this route is safe to have in an example at all.
 */
/**
 * Attempts, not orders.
 *
 * Counting orders instead was a bug worth keeping the note for: a failed
 * attempt never reaches `ORDERS`, so once the count hit the failing remainder
 * it stayed there and every subsequent charge failed forever.
 */
let attempts = 0

export default defineEventHandler(async (event) => {
  const body = await readBody<{ lines?: OrderLine[] }>(event)
  const lines = body?.lines ?? []
  const total = totalFor(lines)

  attempts += 1

  // Every fifth attempt, so a seeding run produces both outcomes rather than
  // a wall of one of them.
  if (attempts % 5 === 0) {
    throw createError({
      statusCode: 502,
      statusMessage: 'upstream payment provider refused the charge (ECONNREFUSED)',
      data: {
        provider: 'stripe',
        // Deliberately sensitive, to prove it is redacted on the way in.
        cardToken: 'tok_live_4242424242424242',
        amount: total,
      },
    })
  }

  const id = nextOrderId()

  ORDERS.set(id, {
    id,
    lines,
    total,
    // Off by design on some orders — see `confirm.post.ts`. Rounding a
    // per-line discount and then charging the rounded sum is how this happens
    // in real code, and nothing about the response says it went wrong.
    charged: lines.length > 1 ? total - 500 : total,
    currency: 'EUR',
    createdAt: Date.now(),
  })

  return { orderId: id, total, currency: 'EUR' as const }
})
