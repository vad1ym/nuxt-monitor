import { createError, defineEventHandler, readBody } from '#imports'
import { createSession, verifyPassword } from '../auth'
import { monitorConfig, useMonitorAuth } from '../context'
import { clientAddress, loginThrottle, setSessionCookie } from '../session'

export default defineEventHandler(async (event) => {
  const config = monitorConfig()
  const auth = useMonitorAuth()

  if (!auth) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  const ip = clientAddress(event)
  const delay = loginThrottle.delayFor(ip)

  if (delay > 0) {
    // Sleeping here rather than rejecting keeps the client's own retry loop
    // slow, which is the point of the backoff.
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  const body = await readBody<{ username?: string, password?: string }>(event).catch(() => ({}))
  const username = typeof body?.username === 'string' ? body.username : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  // Both checks always run: short-circuiting on a wrong username would make
  // "user exists" measurable through response time.
  const usernameOk = username === auth.username
  const passwordOk = verifyPassword(password, auth.passwordHash)

  if (!usernameOk || !passwordOk) {
    loginThrottle.recordFailure(ip)

    // One message for both failures — which half was wrong is not the
    // caller's business.
    throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  }

  loginThrottle.recordSuccess(ip)

  const token = createSession({ secret: auth.secret, ttl: auth.ttl })
  setSessionCookie(event, token, auth, config.route)

  return { ok: true }
})
