import { createError, defineEventHandler } from '#imports'
import { useMonitorAuth } from '../context'
import { hasValidSession } from '../session'

/**
 * Lets the SPA decide between the login screen and the dashboard without
 * having to provoke a 401 first.
 */
export default defineEventHandler((event) => {
  const auth = useMonitorAuth()

  if (!auth) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  // In a development build with `auth.optional` there is nothing to log into,
  // and `passwordHash` may be empty — so the SPA must be told it is already
  // through rather than shown a login form no password can satisfy.
  return { authenticated: auth.optional || hasValidSession(event, auth) }
})
