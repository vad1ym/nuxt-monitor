/**
 * What to write when there is more than there is any point in writing.
 *
 * The existing ceilings — `maxEventsPerIssue`, `maxIssues`, `maxDatabaseMb` —
 * all evict *after* the fact. They bound the database, which is necessary and
 * not sufficient: a route failing on every request still pays the full cost of
 * recording each occurrence, still pushes every other event out of the shared
 * buffer, and is then thrown away by the trimmer anyway. The work is done, the
 * eviction is done, and the outcome is the same as not having recorded it.
 *
 * So this decides at the door instead, and it holds one thing sacred: the
 * **count stays exact**. What a monitoring tool must never do is under-report
 * how often something happened — "12 occurrences" when it was 40,000 is worse
 * than no number, because it reads as a curiosity rather than an emergency.
 * Occurrences that are not stored are still counted, and the issue's own
 * history — the first ones, and a steady trickle after — is what gets kept.
 */

export interface SamplingOptions {
  /**
   * Occurrences stored per issue per window before sampling starts.
   *
   * The first ones are the ones worth having: they carry the stack, the
   * context and the breadcrumbs, and the fiftieth copy of a loop adds nothing
   * the first ten did not.
   */
  burst?: number
  /**
   * Of the occurrences past the burst, keep one in this many. Default: 20.
   *
   * Not zero. A trickle keeps the issue's chart honest about *when* it was
   * still happening and keeps `last_seen` moving, which is what tells somebody
   * a fault is ongoing rather than over.
   */
  keepOneIn?: number
  /** Length of the burst window in ms. Default: one minute. */
  windowMs?: number
  /**
   * Ceiling on tracked fingerprints. Past it the oldest are forgotten, which
   * only means their burst allowance resets — the cost of being wrong here is
   * storing a few more events, not losing any.
   */
  maxTracked?: number
  now?: () => number
}

/**
 * Whether one occurrence's event body is written.
 *
 * A bare boolean: the arithmetic that keeps the count true lives in
 * `drainPending`, not here, because a spike can stop between two occurrences
 * and a weight riding on "the next stored one" would be lost when it does.
 */
export type SamplingDecision = boolean

interface Bucket {
  /** Start of the current window. */
  since: number
  /** Occurrences seen in this window, stored or not. */
  seen: number
  /** Occurrences counted but not stored, waiting to be attributed. */
  pending: number
}

/**
 * Per-issue admission control.
 *
 * Deliberately in memory and per process. A shared counter in the database
 * would be correct across a cluster and would also put a read on the path this
 * exists to make cheaper; being approximately right per process is what the
 * feature is for.
 */
export class Sampler {
  private buckets = new Map<string, Bucket>()
  private readonly burst: number
  private readonly keepOneIn: number
  private readonly windowMs: number
  private readonly maxTracked: number
  private readonly now: () => number

  constructor(options: SamplingOptions = {}) {
    this.burst = Math.max(0, options.burst ?? 0)
    this.keepOneIn = Math.max(1, options.keepOneIn ?? 20)
    this.windowMs = Math.max(1_000, options.windowMs ?? 60_000)
    this.maxTracked = Math.max(1, options.maxTracked ?? 5_000)
    this.now = options.now ?? Date.now
  }

  /** False when no burst was configured, so the caller can skip the work. */
  get active(): boolean {
    return this.burst > 0
  }

  /**
   * Decides one occurrence.
   *
   * Called on the hot path — inside Nitro's error hook — so it is a map lookup
   * and arithmetic, with no allocation on the common path.
   */
  admit(fingerprint: string): SamplingDecision {
    if (!this.active) {
      return true
    }

    const now = this.now()
    let bucket = this.buckets.get(fingerprint)

    // A new window forgets the previous one's count but *not* its pending
    // weight: those occurrences really happened, and dropping them here would
    // be the under-reporting this whole file exists to avoid.
    if (!bucket || now - bucket.since >= this.windowMs) {
      bucket = { since: now, seen: 0, pending: bucket?.pending ?? 0 }
      this.buckets.set(fingerprint, bucket)
      this.evict()
    }

    bucket.seen++

    // The burst, then one in `keepOneIn` after it.
    const stored = bucket.seen <= this.burst
      || (bucket.seen - this.burst) % this.keepOneIn === 0

    if (stored) {
      return true
    }

    // Counted here, attributed by `drainPending` on the next flush. The weight
    // deliberately does *not* ride on the next stored occurrence: a spike that
    // stops mid-window would leave the last skipped ones with nothing to carry
    // them, and the issue would report fewer occurrences than happened.
    bucket.pending++

    return false
  }

  /**
   * Forgets the oldest fingerprints past the ceiling.
   *
   * Being wrong here costs a reset burst allowance — a few more events stored
   * than strictly needed — and never a lost count: an occurrence whose bucket
   * has gone away is admitted, stored and counted as one.
   */
  private evict(): void {
    if (this.buckets.size <= this.maxTracked) {
      return
    }

    // Map iteration is insertion-ordered, and a bucket is re-inserted when its
    // window rolls, so the front of the map is the least recently active.
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key)

      if (this.buckets.size <= this.maxTracked) {
        return
      }
    }
  }

  /**
   * Weights left over from occurrences that were never attributed.
   *
   * A spike that stops mid-window leaves skipped occurrences with no next
   * event to carry them, and left there they would simply be lost — the issue
   * would report fewer occurrences than happened, which is the one outcome
   * this file exists to prevent. The store drains this on every flush and adds
   * it to the counts.
   *
   * Returned and cleared together so a drain cannot double-count.
   */
  drainPending(): Map<string, number> {
    const owed = new Map<string, number>()

    for (const [fingerprint, bucket] of this.buckets) {
      if (bucket.pending > 0) {
        owed.set(fingerprint, bucket.pending)
        bucket.pending = 0
      }
    }

    return owed
  }

  /** Occurrences counted but not yet attributed, for the health endpoint. */
  get pending(): number {
    let total = 0

    for (const bucket of this.buckets.values()) {
      total += bucket.pending
    }

    return total
  }

  /** Fingerprints currently being tracked. */
  get tracked(): number {
    return this.buckets.size
  }
}
