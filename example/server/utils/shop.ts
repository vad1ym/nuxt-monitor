/**
 * The shop's data, such as it is.
 *
 * An in-memory catalogue rather than a database, because the example is about
 * what a monitor sees, not about persistence. What matters here is that the
 * shapes are *believable*: an order has a currency and line items, a product
 * can be out of stock, and a price is an integer number of cents — so the
 * failures further down read like failures somebody would actually get paged
 * for, rather than like a route named `/api/throw`.
 */

export interface Product {
  slug: string
  title: string
  /** Cents. Money as a float is its own genre of production incident. */
  price: number
  currency: 'EUR'
  stock: number
  /** Deliberately absent on one product — see `catalog/[slug].get.ts`. */
  dimensions?: { width: number, height: number }
}

export const CATALOG: Product[] = [
  { slug: 'aeron-chair', title: 'Aeron Chair', price: 129_900, currency: 'EUR', stock: 4, dimensions: { width: 68, height: 104 } },
  { slug: 'standing-desk', title: 'Standing Desk', price: 74_900, currency: 'EUR', stock: 11, dimensions: { width: 160, height: 75 } },
  { slug: 'desk-lamp', title: 'Desk Lamp', price: 8_900, currency: 'EUR', stock: 0, dimensions: { width: 14, height: 42 } },
  { slug: 'monitor-arm', title: 'Monitor Arm', price: 19_900, currency: 'EUR', stock: 7, dimensions: { width: 22, height: 48 } },
  // No `dimensions`. A row that came from an older import and never got
  // backfilled — the single most common shape of a real TypeError.
  { slug: 'cable-tray', title: 'Cable Tray', price: 3_900, currency: 'EUR', stock: 23 },
]

export function findProduct(slug: string): Product | undefined {
  return CATALOG.find(product => product.slug === slug)
}

/** Cents to something a person reads. */
export function formatPrice(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100)
}

export interface OrderLine {
  slug: string
  quantity: number
}

/**
 * A tiny order book, so the checkout has something to be inconsistent about.
 *
 * Reset on every server start, which is fine: the point is that
 * `/api/checkout/confirm` can find an order it disagrees with, not that the
 * order survives a restart.
 */
export const ORDERS = new Map<string, {
  id: string
  lines: OrderLine[]
  total: number
  charged: number
  currency: 'EUR'
  createdAt: number
}>()

let sequence = 4_820

export function nextOrderId(): string {
  sequence += 1

  return `ORD-${sequence}`
}

/** What the lines add up to, which is not always what the card was charged. */
export function totalFor(lines: OrderLine[]): number {
  return lines.reduce((sum, line) => {
    const product = findProduct(line.slug)

    return sum + (product ? product.price * line.quantity : 0)
  }, 0)
}
