/**
 * The idiomatic way to fail a request in Nitro. Carries a status code and a
 * data payload, both of which should survive into the captured context.
 */
export default defineEventHandler(() => {
  throw createError({
    // 5xx on purpose: 4xx statuses are ignored by default, since a client
    // asking for something absent is not a fault in the application.
    statusCode: 502,
    statusMessage: 'Order could not be placed',
    data: { orderId: 4821, reason: 'insufficient stock' },
  })
})
