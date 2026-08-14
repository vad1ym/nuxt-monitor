/**
 * The status a failed request ended with, as the client saw it.
 *
 * What was actually written wins. That sounds obvious and was not what this
 * did: it preferred the status carried on the error, and for a `FetchError`
 * that number describes a *different* request — the call the handler made to
 * somebody else. Whether the framework then passes that status on to the
 * browser is its decision, not ours to predict. Nuxt sometimes does (a page
 * whose `$fetch` gets 422 can answer 422) and sometimes does not (an error
 * escaping mid-render answers 500), so guessing from the error's type was
 * wrong in one direction or the other every time.
 *
 * Reading the response settles it without guessing: by the time the error hook
 * runs, the status the client is getting is either already set or not set at
 * all. `createError({ statusCode })` still works, because h3 has applied it to
 * the response before we look.
 *
 * This matters beyond a mislabelled row. The ignore rules filter on this
 * number, so a wrong one does not misdescribe an error — it deletes it.
 */
export function statusOf(error: Error, written: number | undefined): number {
  // h3 reports 200 while the response is still being produced, which is not a
  // status a *failed* request can have ended with — so it means "not decided
  // yet" rather than "succeeded".
  if (written && written >= 400) {
    return written
  }

  const declared = (error as { statusCode?: number }).statusCode

  // Nothing written yet. The error's own claim is the best guess left, except
  // when it was borrowed from an outgoing call — that status belongs to
  // somebody else's response, and this one is a 500 until proven otherwise.
  if (!isFetchError(error) && typeof declared === 'number' && declared >= 100 && declared <= 599) {
    return declared
  }

  return 500
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
