/**
 * Server middleware, which runs before any route handler.
 *
 * A failure here aborts the request from a different place in the stack than a
 * handler throw does — there is no route handler in the trace at all — and a
 * rate limiter is the most ordinary reason to have middleware that can fail.
 *
 * Scoped to one path so it does not break the rest of the shop.
 */
export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/admin/bulk')) {
    return
  }

  const quota = undefined as { remaining: number } | undefined

  // The limiter's backing store is unreachable, so the quota lookup returns
  // nothing and this reads through it. A cache going away is not exotic; a
  // middleware that assumes it is always there is the bug.
  if (quota!.remaining <= 0) {
    throw createError({ statusCode: 429, statusMessage: 'Slow down' })
  }
})
