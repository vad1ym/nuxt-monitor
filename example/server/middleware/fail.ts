/**
 * Server middleware runs before route handlers, so a failure here aborts the
 * request from a different place in the stack than a handler throw.
 *
 * Scoped to one path so it does not break the rest of the example.
 */
export default defineEventHandler((event) => {
  if (event.path.startsWith('/middleware-error')) {
    throw new Error('Server middleware rejected the request')
  }
})
