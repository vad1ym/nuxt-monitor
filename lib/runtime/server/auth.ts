import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

/**
 * Password hashing and session signing for the dashboard.
 *
 * Everything here is built on `node:crypto` — no dependency is worth taking
 * for a login form, and fewer moving parts means fewer ways to get it wrong.
 */

const SCRYPT_KEYLEN = 64
const SALT_BYTES = 16

/**
 * `scrypt` parameters. N=2^15 costs roughly 100ms per hash here, which is
 * unnoticeable on a login and expensive enough to make offline guessing of a
 * leaked hash impractical.
 */
const SCRYPT_PARAMS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** Produces `scrypt$N$r$p$salt$hash`, carrying its own parameters. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)

  const { N, r, p } = SCRYPT_PARAMS
  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$')
}

/**
 * Checks a password against a stored hash.
 *
 * Parameters are read from the hash rather than from the current constants, so
 * raising the cost later does not lock out existing users.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')

  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false
  }

  const [, n, r, p, saltB64, hashB64] = parts

  try {
    const salt = Buffer.from(saltB64!, 'base64')
    const expected = Buffer.from(hashB64!, 'base64')
    const derived = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    })

    return timingSafeEqual(derived, expected)
  }
  catch {
    // Malformed hash, or scrypt parameters the runtime refuses.
    return false
  }
}

export interface SessionOptions {
  secret: string
  /** Lifetime in seconds. */
  ttl: number
}

/**
 * Issues a signed session token.
 *
 * Format is `base64url(payload).base64url(hmac)`. The payload holds only an
 * expiry and a nonce — there is nothing to look up, so no session table has to
 * be kept, survive restarts, or be shared between instances.
 */
export function createSession(options: SessionOptions, now = Date.now()): string {
  const payload = JSON.stringify({
    exp: now + options.ttl * 1_000,
    nonce: randomBytes(8).toString('base64url'),
  })

  const encoded = Buffer.from(payload).toString('base64url')

  return `${encoded}.${sign(encoded, options.secret)}`
}

/**
 * Validates a session token.
 *
 * The signature is checked before the payload is trusted, and compared in
 * constant time so the correct prefix length cannot be discovered by timing.
 */
export function verifySession(token: string | undefined, options: SessionOptions, now = Date.now()): boolean {
  if (!token) {
    return false
  }

  const dot = token.lastIndexOf('.')

  if (dot <= 0) {
    return false
  }

  const encoded = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  if (!safeEqual(signature, sign(encoded, options.secret))) {
    return false
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { exp?: number }

    return typeof payload.exp === 'number' && payload.exp > now
  }
  catch {
    return false
  }
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

/** Constant-time comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)

  // `timingSafeEqual` throws on length mismatch, and the lengths here are not
  // secret, so compare them first.
  if (bufA.length !== bufB.length) {
    return false
  }

  return timingSafeEqual(bufA, bufB)
}

/**
 * Derives a signing secret when none is configured.
 *
 * Tying it to the credential means changing the password invalidates every
 * outstanding session, which is what a password change is supposed to do.
 *
 * The material must be stable across restarts. A `scrypt` hash is not: it is
 * salted randomly, so deriving from one logged everybody out on every boot and
 * left two instances behind a load balancer unable to read each other's
 * cookies.
 */
export function deriveSecret(material: string): string {
  return createHmac('sha256', 'nuxt-monitor/session').update(material).digest('base64url')
}

/**
 * Login throttle.
 *
 * Delay grows with consecutive failures per IP, so an online guessing attack
 * stalls quickly while a person who mistypes their password waits milliseconds.
 */
export class LoginThrottle {
  private attempts = new Map<string, { count: number, last: number }>()

  constructor(
    private readonly windowMs = 15 * 60 * 1_000,
    private readonly maxTracked = 10_000,
  ) {}

  /** Milliseconds the caller should wait before this attempt is considered. */
  delayFor(ip: string, now = Date.now()): number {
    const entry = this.attempts.get(ip)

    if (!entry || now - entry.last > this.windowMs) {
      return 0
    }

    // 0, 0, 0, then 1s, 2s, 4s … capped at 30s.
    if (entry.count < 3) {
      return 0
    }

    return Math.min(2 ** (entry.count - 3) * 1_000, 30_000)
  }

  recordFailure(ip: string, now = Date.now()): void {
    const entry = this.attempts.get(ip)

    if (!entry || now - entry.last > this.windowMs) {
      this.attempts.set(ip, { count: 1, last: now })
    }
    else {
      entry.count++
      entry.last = now
    }

    this.evictIfNeeded(now)
  }

  recordSuccess(ip: string): void {
    this.attempts.delete(ip)
  }

  /** Keeps the map from growing without bound under a distributed attack. */
  private evictIfNeeded(now: number): void {
    if (this.attempts.size <= this.maxTracked) {
      return
    }

    for (const [ip, entry] of this.attempts) {
      if (now - entry.last > this.windowMs) {
        this.attempts.delete(ip)
      }
    }

    // Still oversized: drop the oldest entries outright.
    if (this.attempts.size > this.maxTracked) {
      const sorted = [...this.attempts.entries()].sort((a, b) => a[1].last - b[1].last)

      for (const [ip] of sorted.slice(0, this.attempts.size - this.maxTracked)) {
        this.attempts.delete(ip)
      }
    }
  }
}
