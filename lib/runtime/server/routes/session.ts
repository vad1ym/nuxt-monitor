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

  return { authenticated: hasValidSession(event, auth) }
})
