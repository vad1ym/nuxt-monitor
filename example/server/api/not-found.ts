/**
 * A 4xx failure, which is the shape of most real-world noise: a client asked
 * for something that is not there. It should be collected only when the
 * default ignore rules are turned off.
 */
export default defineEventHandler(() => {
  throw createError({
    statusCode: 404,
    statusMessage: 'No such widget',
  })
})
