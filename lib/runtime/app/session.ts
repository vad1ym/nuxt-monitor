/**
 * Per-tab session identity.
 *
 * The point of it is arithmetic, not identification: 250 events across 3
 * sessions is a retry loop, across 250 sessions it is an outage, and the two
 * need different responses. A random value in `sessionStorage` answers that
 * and nothing else — it is not derived from anything about the visitor, it
 * dies with the tab, and it cannot be joined against a later visit. That keeps
 * it outside the definition of a cookie requiring consent, which a persistent
 * `localStorage` id would not be.
 */

const KEY = 'monitor:sid'

/** Short enough to store on every event, wide enough not to collide. */
function newId(): string {
  const random = globalThis.crypto?.randomUUID?.()

  if (random) {
    return random.replace(/-/g, '').slice(0, 16)
  }

  // `crypto` is absent on insecure origins in some browsers; collisions only
  // blur the session count slightly, so a weaker source is acceptable here.
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

let memory: string | undefined

export function sessionId(): string {
  // Storage throws in private modes and when cookies are blocked entirely.
  // An in-memory id still groups events within one page load, which is most
  // of the value, so failure here degrades rather than removes the facet.
  try {
    const existing = sessionStorage.getItem(KEY)

    if (existing) {
      return existing
    }

    const created = newId()
    sessionStorage.setItem(KEY, created)

    return created
  }
  catch {
    return memory ??= newId()
  }
}
