import { findProduct } from '../../utils/shop'

/**
 * One product, with its shipping box computed from the dimensions.
 *
 * Two different failures live here, and the difference between them is the
 * whole reason a monitor separates 4xx from 5xx:
 *
 *   - an unknown slug is a **404**, which is somebody asking for a page that is
 *     not there. Ignored by default, and rightly: it is not a fault in the
 *     application.
 *   - `cable-tray` has no `dimensions`, because it came from an older import
 *     that never got backfilled. Reading through it is a **TypeError**, and it
 *     is a real bug that only fires for one row in the catalogue — which is
 *     exactly the kind of thing that survives a manual test pass and shows up
 *     in a monitor a week later.
 */
export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug') ?? ''
  const product = findProduct(slug)

  if (!product) {
    throw createError({
      statusCode: 404,
      statusMessage: `No product named ${slug}`,
    })
  }

  // Throws for `cable-tray`, and only for `cable-tray`.
  const volume = product.dimensions!.width * product.dimensions!.height

  return {
    ...product,
    shipping: { boxArea: volume },
  }
})
