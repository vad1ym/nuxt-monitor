/**
 * The status a failed request ended with, as the client saw it.
 *
 * `createError({ statusCode })` carries its own; anything else that escaped a
 * handler became a 500 by the time the client saw it.
 *
 * A `FetchError` is the exception, and the reason this is not a one-liner. It
 * also carries a `statusCode`, but that number describes a *different* request
 * — the call the handler made to somebody else. A page whose `$fetch` got 422
 * from an upstream API does not answer 422; it answers 500 and shows an error
 * page. Taking the borrowed number made a crashed render report the upstream's
 * status, and since the ignore rules filter on status, it then vanished
 * entirely behind a code that was never sent to anyone.
 */
export function statusOf(error: Error, written: number | undefined): number {
  const declared = (error as { statusCode?: number }).statusCode
  const borrowed = isFetchError(error)

  if (!borrowed && typeof declared === 'number' && declared >= 100 && declared <= 599) {
    return declared
  }

  // The response may not be written yet, in which case h3 reports 200. Passed
  // in rather than read here so this stays a pure function of the error and
  // the response — testable without a live H3 event.
  return written && written >= 400 ? written : 500
}

/**
 * Whether this error describes an outgoing call rather than this response.
 *
 * Matched on the name rather than with `instanceof`: `ofetch` is the
 * application's dependency, not ours, and in a pnpm workspace there may be
 * several copies of it — a constructor check would pass for one and fail for
 * the next, which is the kind of difference that shows up only in somebody
 * else's repository.
 *
 * The `cause` is checked too, because Nuxt rewraps a failed `$fetch` during
 * SSR: by the time the error hook sees it, the `FetchError` is often one layer
 * down rather than the error itself.
 */
export function isFetchError(error: Error): boolean {
  return error?.name === 'FetchError' || (error as { cause?: Error })?.cause?.name === 'FetchError'
}
