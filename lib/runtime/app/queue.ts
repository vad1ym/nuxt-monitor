import type { MonitorBreadcrumb, MonitorFacets } from '../../types'

/** What the browser sends to `/_monitor/api/ingest`. */
export interface ClientEvent {
  type: string
  message: string
  stack?: string
  timestamp: number
  context?: Record<string, unknown>
  breadcrumbs?: MonitorBreadcrumb[]
  /** Only what the browser knows: session and release. The rest is derived
   * server-side from the request headers. */
  facets?: MonitorFacets
}

export interface QueueOptions {
  /** Sends a batch. Returns false if the caller should retry later. */
  send: (events: ClientEvent[]) => boolean
  /** Events buffered before an early send. */
  batchSize?: number
  /** Window during which an identical error is treated as already reported. */
  dedupeWindowMs?: number
  /** Cap on events accepted per window, to survive an error loop. */
  rateLimit?: number
  rateWindowMs?: number
  now?: () => number
}

/**
 * Client-side batching and de-duplication.
 *
 * One fault can reach us from several places at once — Vue's handler, the
 * global `error` listener, and `unhandledrejection` can all observe the same
 * throw — so identical events inside a short window collapse to one. Without
 * that, a render error in a loop would flood both the network and the store.
 */
export class EventQueue {
  private pending: ClientEvent[] = []
  private recent = new Map<string, number>()
  private windowStart: number
  private windowCount = 0

  private readonly batchSize: number
  private readonly dedupeWindowMs: number
  private readonly rateLimit: number
  private readonly rateWindowMs: number
  private readonly now: () => number

  constructor(private options: QueueOptions) {
    this.batchSize = options.batchSize ?? 10
    this.dedupeWindowMs = options.dedupeWindowMs ?? 5_000
    this.rateLimit = options.rateLimit ?? 50
    this.rateWindowMs = options.rateWindowMs ?? 60_000
    this.now = options.now ?? (() => Date.now())
    this.windowStart = this.now()
  }

  /** Queues an event. Returns false when dropped as a duplicate or over limit. */
  add(event: ClientEvent): boolean {
    const now = this.now()

    if (this.isRateLimited(now)) {
      return false
    }

    const key = dedupeKey(event)
    const seen = this.recent.get(key)

    if (seen !== undefined && now - seen < this.dedupeWindowMs) {
      return false
    }

    this.recent.set(key, now)
    this.pruneRecent(now)

    this.pending.push(event)
    this.windowCount++

    if (this.pending.length >= this.batchSize) {
      this.flush()
    }

    return true
  }

  /** Sends everything queued. Retains the batch if the send fails. */
  flush(): void {
    if (this.pending.length === 0) {
      return
    }

    const batch = this.pending
    this.pending = []

    if (!this.options.send(batch)) {
      // Put it back, newest last, so a failed send is retried on the next
      // flush rather than silently lost.
      this.pending = [...batch, ...this.pending].slice(-this.batchSize * 2)
    }
  }

  get size(): number {
    return this.pending.length
  }

  private isRateLimited(now: number): boolean {
    if (now - this.windowStart > this.rateWindowMs) {
      this.windowStart = now
      this.windowCount = 0
    }

    return this.windowCount >= this.rateLimit
  }

  private pruneRecent(now: number): void {
    if (this.recent.size < 100) {
      return
    }

    for (const [key, seen] of this.recent) {
      if (now - seen > this.dedupeWindowMs) {
        this.recent.delete(key)
      }
    }
  }
}

/**
 * Identity for de-duplication.
 *
 * Message plus the first stack line: enough to tell two different faults
 * apart, loose enough that the same fault reported through different paths
 * still collapses.
 */
export function dedupeKey(event: ClientEvent): string {
  const frame = event.stack?.split('\n')[1]?.trim() ?? ''

  return `${event.type}|${event.message}|${frame}`
}
