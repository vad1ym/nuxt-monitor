import type { H3Event } from 'h3'
import {
  deleteCookie,
  getCookie,
  getRequestHeader,
  setCookie,
} from 'h3'
import { LoginThrottle, deriveSecret, hashPassword, verifySession } from './auth'

export const SESSION_COOKIE = 'monitor_session'

/** Shared across requests, so the backoff actually accumulates. */
export const loginThrottle = new LoginThrottle()

export interface MonitorAuthConfig {
  username?: string
  password?: string
  passwordHash?: string
  secret?: string
  sessionTtl?: number
  /**
   * Serve the dashboard without credentials.
   *
   * Resolved at build time and already forced to `false` in a production
   * build, so this is only ever true in dev — see `MonitorAuthOptions`.
   */
  optional?: boolean
}

export interface ResolvedAuth {
  username: string
  passwordHash: string
  secret: string
  ttl: number
  /**
   * Whether a session is required at all.
   *
   * Only ever true in a development build. `passwordHash` may be empty in that
   * case, which is exactly why the login route has to check this before
   * treating a request as a credential check.
   */
  optional: boolean
}

/**
 * Turns configured credentials into the values the handlers need.
 *
 * A plaintext `password` is hashed once at startup so the rest of the code
 * only ever handles a hash, and a hash is never compared against a plaintext
 * by accident.
 */
export function resolveAuth(config: MonitorAuthConfig): ResolvedAuth | undefined {
  // `||` rather than `??` throughout: runtimeConfig serializes absent values
  // as empty strings, which are not nullish but are certainly not credentials.
  const passwordHash = config.passwordHash
    || (config.password ? hashPassword(config.password) : '')

  // `optional` is the one way to resolve without a credential. It is decided
  // at build time and is always false in production, so this cannot become a
  // way to serve the dashboard unauthenticated on a deployed server.
  if (!passwordHash && !config.optional) {
    return undefined
  }

  return {
    username: config.username || 'admin',
    passwordHash,
    optional: Boolean(config.optional),
    // Derived from the credential itself, never from `passwordHash`.
    //
    // Hashing a plaintext password salts it randomly, so the hash — and any
    // secret derived from it — changed on every boot. Sessions died at each
    // restart, and no two instances behind a load balancer ever agreed on a
    // cookie. A configured `passwordHash` is already stable, so it stays the
    // material in that case.
    secret: config.secret || deriveSecret(config.passwordHash || config.password || ''),
    ttl: config.sessionTtl || 60 * 60 * 24 * 7,
  }
}

export function hasValidSession(event: H3Event, auth: ResolvedAuth): boolean {
  return verifySession(getCookie(event, SESSION_COOKIE), {
    secret: auth.secret,
    ttl: auth.ttl,
  })
}

export function setSessionCookie(event: H3Event, token: string, auth: ResolvedAuth, routeBase: string): void {
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    // Off in dev, where the dashboard is served over plain http on localhost.
    secure: !import.meta.dev,
    sameSite: 'lax',
    // Scoped to the dashboard, so it is never attached to application requests.
    path: routeBase,
    maxAge: auth.ttl,
  })
}

export function clearSessionCookie(event: H3Event, routeBase: string): void {
  deleteCookie(event, SESSION_COOKIE, { path: routeBase })
}

/**
 * Best-effort client address for throttling.
 *
 * Proxy headers are attacker-controlled, so this is a rate-limiting hint and
 * nothing more — it must never be used for an authorization decision.
 */
export function clientAddress(event: H3Event): string {
  const forwarded = getRequestHeader(event, 'x-forwarded-for')

  if (forwarded) {
    return forwarded.split(',')[0]!.trim()
  }

  return getRequestHeader(event, 'x-real-ip')
    ?? event.node?.req?.socket?.remoteAddress
    ?? 'unknown'
}
