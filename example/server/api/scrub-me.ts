/**
 * Fails while the request carries credentials in both headers and the query
 * string. Nothing sensitive here should ever appear in the stored event.
 */
export default defineEventHandler((event) => {
  const token = getQuery(event).token

  throw createError({
    statusCode: 500,
    statusMessage: 'Upstream rejected the request',
    data: {
      // Deliberately sensitive keys, to prove they are redacted on the way in.
      password: 'hunter2',
      apiKey: 'sk-live-should-never-be-stored',
      requestedToken: token,
      safeField: 'this one should survive',
    },
  })
})
