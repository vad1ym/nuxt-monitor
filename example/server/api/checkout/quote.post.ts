import { findProduct, totalFor } from '../../utils/shop'
import type { OrderLine } from '../../utils/shop'

/**
 * Prices a basket before anyone pays.
 *
 * Succeeds for an ordinary basket, and fails the way a real pricing endpoint
 * fails: a line naming something the catalogue does not have. A basket is
 * built from state the browser has been carrying since a previous deploy, so
 * a slug that no longer exists is not a hypothetical.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ lines?: OrderLine[] }>(event)
  const lines = body?.lines ?? []

  if (!lines.length) {
    throw createError({ statusCode: 400, statusMessage: 'The basket is empty' })
  }

  for (const line of lines) {
    const product = findProduct(line.slug)

    if (!product) {
      // A 5xx, not a 400: the browser sent what we gave it, so a basket we
      // can no longer price is our problem and belongs in the issue list.
      throw createError({
        statusCode: 500,
        statusMessage: 'Basket contains a product that is no longer in the catalogue',
        data: { slug: line.slug },
      })
    }

    if (product.stock < line.quantity) {
      throw createError({
        statusCode: 409,
        statusMessage: `${product.title} is out of stock`,
        data: { slug: line.slug, wanted: line.quantity, available: product.stock },
      })
    }
  }

  return { total: totalFor(lines), currency: 'EUR' as const }
})
