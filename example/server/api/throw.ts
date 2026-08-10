/** Plainest case: an unguarded throw inside a route handler. */
export default defineEventHandler(() => {
  const config = { retries: 3 } as { retries: number, endpoint?: { url: string } }

  // A property read on undefined — the most common shape of a real TypeError.
  return config.endpoint!.url.toUpperCase()
})
