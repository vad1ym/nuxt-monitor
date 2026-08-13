/**
 * Fails while the request carries credentials in both the headers and the
 * query string. Nothing sensitive here should ever appear in the stored event.
 *
 * An export endpoint is where those credentials plausibly are: a script hits
 * it on a schedule with a long-lived token in the URL, because whoever wrote
 * the cron entry found that easier than a header.
 */
export default defineEventHandler((event) => {
  const token = getQuery(event).token

  throw createError({
    statusCode: 500,
    statusMessage: 'Export job could not reach the warehouse',
    data: {
      // Deliberately sensitive keys, to prove they are redacted on the way in.
      password: 'hunter2',
      apiKey: 'sk-live-should-never-be-stored',
      requestedToken: token,
      warehouse: 'eu-west-1',
      safeField: 'this one should survive',
    },
  })
})
