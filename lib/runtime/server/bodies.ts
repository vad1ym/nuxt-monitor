import type { H3Event } from 'h3'
import type { MonitorCaptureOptions } from '../../types'
import { scrub } from '../shared/scrub'

/**
 * The request and response bodies of a failing request.
 *
 * A stack says where the code broke; a body says what broke it. "Cannot read
 * properties of undefined" is one bug or fifty depending on what was posted,
 * and without the payload the first thing anybody does is try to guess it.
 *
 * Both halves are bounded, redacted, and only ever read for a failure —
 * a successful request is never touched, so this cannot turn into a log of
 * everything users typed. The request half is off unless somebody turns it on,
 * because that is where passwords and card numbers live; the response half is
 * on, because the application wrote it and for a failure it is usually the
 * error envelope you would have asked for first.
 */

const DEFAULT_MAX_BYTES = 8_192

/** Marks a body that did not fit, so nobody debugs a truncated payload unaware. */
const TRUNCATED = '…[truncated]'

export interface CapturedBodies {
  requestBody?: unknown
  responseBody?: unknown
}

/**
 * Where h3 keeps what it has already parsed and read.
 *
 * Global symbols, registered by h3 itself — looked up through `Symbol.for`
 * rather than imported because they are not exported, and because a global
 * symbol is stable across two copies of h3 in one process, which a private one
 * would not be.
 */
const PARSED_BODY = Symbol.for('h3ParsedBody')
const RAW_BODY = Symbol.for('h3RawBody')

/** Where the snapshot below is parked, on the event's own context. */
const SNAPSHOT = '_monitorRequestBody'

/**
 * Copies the parsed body onto the event while the request is still running.
 *
 * Called from the response hook rather than read at error time. Reading h3's
 * cache from inside the error hook worked and then did not, run to run: an
 * error travels up through Nitro before it is dispatched, and the event that
 * arrives is not reliably carrying the `node.req` the handler read from. A
 * body that appears on some occurrences of an issue and not others is worse
 * than one that never appears — it invites the reader to conclude something
 * about the requests that "had no body".
 *
 * Cheap: a property read and an assignment, both only when the option is on.
 * Nothing is parsed here that the handler did not already parse.
 */
export function snapshotRequestBody(event: H3Event, options: MonitorCaptureOptions | undefined): void {
  if (options?.request !== true) {
    return
  }

  const request = event.node?.req as unknown as Record<string | symbol, unknown> | undefined
  const parsed = request?.[PARSED_BODY]

  if (parsed !== undefined) {
    (event.context as Record<string, unknown>)[SNAPSHOT] = parsed
  }
}

/**
 * What h3 already parsed for this request.
 *
 * Read from h3's own cache rather than by calling `readBody` again: by the
 * time an error surfaces the stream is consumed, and a second read would
 * either return nothing or — worse — hang waiting for a body that has already
 * been delivered. If the handler never read the body, there is nothing here,
 * and that is the correct answer: a request whose body was never parsed did
 * not fail because of it.
 *
 * The parsed value is preferred over the raw one; the raw is a `Buffer` that
 * has been resolved, so it is only useful for a handler that read the body
 * without parsing it.
 */
function parsedRequestBody(event: H3Event): unknown {
  // Through `unknown`: the caches below are set by h3 and by Nitro's adapters,
  // none of which are in `IncomingMessage`'s type.
  const request = event.node?.req as unknown as Record<string | symbol, unknown> | undefined

  if (!request) {
    return undefined
  }

  // Taken during the request, if it was — see `snapshotRequestBody`. h3's own
  // cache is checked after it rather than before, because by the time an error
  // has travelled up through Nitro the event reaching the hook is not always
  // carrying the same `node.req` the handler read from, and a body that is
  // sometimes there is worse than one that always is.
  const snapshot = (event.context as Record<string, unknown> | undefined)?.[SNAPSHOT]

  if (snapshot !== undefined) {
    return snapshot
  }

  const parsed = request[PARSED_BODY]

  if (parsed !== undefined) {
    return parsed
  }

  // `_requestBody` is what Nitro sets when it invokes a handler internally,
  // and `body`/`rawBody` are what other adapters leave behind.
  const fallback = request._requestBody ?? request.body ?? request.rawBody

  // The raw entry is a promise while the read is in flight and a Buffer after.
  // A promise is no use here — this runs synchronously inside the error hook —
  // and a Buffer is worth decoding.
  const raw = fallback ?? request[RAW_BODY]

  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString('utf8')
  }

  return typeof raw === 'string' || (raw !== null && typeof raw === 'object' && !(raw instanceof Promise))
    ? raw
    : undefined
}

/**
 * The body the failure would have produced.
 *
 * Taken from the error rather than from the response stream, which has not
 * been written yet when the error hook runs. `createError({ data })` is the
 * idiomatic way to fail a request in Nitro and the data is exactly what the
 * client is about to receive, so this is the response body in every sense that
 * matters to somebody reading the report later.
 */
function errorResponseBody(error: unknown): unknown {
  const data = (error as { data?: unknown } | undefined)?.data

  return data === undefined ? undefined : data
}

/**
 * Bounds a value, whatever shape it is.
 *
 * Measured after serialisation because that is what actually gets stored, and
 * an object with ten thousand small keys is as expensive as one long string.
 * Truncation produces a string even when the input was an object: half a JSON
 * document is not a JSON document, and pretending otherwise would put
 * unparseable objects in the database.
 */
export function bound(value: unknown, maxBytes: number): unknown {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value === 'string') {
    return value.length > maxBytes ? `${value.slice(0, maxBytes)}${TRUNCATED}` : value
  }

  let serialized: string

  try {
    serialized = JSON.stringify(value) ?? ''
  }
  catch {
    // Circular, or something that throws in `toJSON`. Not worth a second
    // failure while reporting the first.
    return undefined
  }

  if (!serialized) {
    return undefined
  }

  return serialized.length > maxBytes ? `${serialized.slice(0, maxBytes)}${TRUNCATED}` : value
}

/**
 * Collects whichever halves are turned on.
 *
 * Redaction runs over both, using the same key rules as the rest of the event.
 * That is a safety net rather than a licence — it matches keys, so a token
 * inside a field called `payload` still survives it, which is exactly why the
 * request half is off by default.
 */
export function captureBodies(
  event: H3Event | undefined,
  error: unknown,
  options: MonitorCaptureOptions | undefined,
  scrubOptions: { extraKeys: string[] },
): CapturedBodies {
  const maxBytes = normalizeMax(options?.maxBytes)
  const out: CapturedBodies = {}

  // Off unless asked for. The default is the one that cannot leak a password.
  if (event && options?.request === true) {
    const body = bound(parsedRequestBody(event), maxBytes)

    if (body !== undefined) {
      out.requestBody = scrub(body, scrubOptions)
    }
  }

  // On unless turned off — see the note above `errorResponseBody`.
  if (options?.response !== false) {
    const body = bound(errorResponseBody(error), maxBytes)

    if (body !== undefined) {
      out.responseBody = scrub(body, scrubOptions)
    }
  }

  return out
}

function normalizeMax(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : DEFAULT_MAX_BYTES
}
