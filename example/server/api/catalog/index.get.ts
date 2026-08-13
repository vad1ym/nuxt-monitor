import { CATALOG } from '../../utils/shop'

/**
 * The catalogue listing. Succeeds — it is here so the error rate has a
 * denominator that is not itself broken.
 */
export default defineEventHandler(() => {
  return {
    products: CATALOG.map(({ slug, title, price, currency, stock }) => ({
      slug,
      title,
      price,
      currency,
      inStock: stock > 0,
    })),
  }
})
