/** Cents to something a person reads. Mirrors the server's helper. */
export function formatPrice(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100)
}
