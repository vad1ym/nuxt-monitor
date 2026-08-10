import { createError, defineEventHandler } from '#imports'
import { monitorConfig } from '../context'
import { hasTrustedOrigin } from '../origin'
import { clearSessionCookie } from '../session'

export default defineEventHandler((event) => {
  if (!hasTrustedOrigin(event)) {
    throw createError({ statusCode: 403, statusMessage: 'Bad origin' })
  }

  // Unconditional: clearing a cookie that is already absent is harmless, and
  // requiring a valid session to log out would strand anyone holding an
  // expired one.
  clearSessionCookie(event, monitorConfig().route)

  return { ok: true }
})
