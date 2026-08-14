import { describe, expect, it } from 'vitest'
import { isFetchError, statusOf } from './status'

/**
 * The status a failed request ended with.
 *
 * Worth its own file because of one case: a `FetchError` carries the status of
 * a *different* request — the call the handler made to somebody else — and
 * reading it blindly hid crashed pages behind codes that were never sent to
 * anyone. The ignore rules filter on this number, so getting it wrong does not
 * mislabel an error, it deletes it.
 */

function fetchError(status: number): Error {
  const error = new Error(`[GET] "/api/medicines": ${status}`)
  error.name = 'FetchError';
  (error as { statusCode?: number }).statusCode = status

  return error
}

function h3Error(status: number): Error {
  const error = new Error('Not found')
  error.name = 'H3Error';
  (error as { statusCode?: number }).statusCode = status

  return error
}

describe('statusOf', () => {
  it('trusts a status the application declared about this response', () => {
    expect(statusOf(h3Error(404), 404)).toBe(404)
    expect(statusOf(h3Error(403), undefined)).toBe(403)
  })

  it('ignores the status a FetchError borrowed from upstream', () => {
    // The page did not answer 422 — the API it called did. The visitor got an
    // error page, and that is what this has to report.
    expect(statusOf(fetchError(422), 500)).toBe(500)
    expect(statusOf(fetchError(404), 500)).toBe(500)
  })

  it('falls back to 500 when nothing was written yet', () => {
    // h3 reports 200 while the response is still being produced, and an error
    // that escaped a handler is a 500 by the time anybody sees it.
    expect(statusOf(fetchError(422), 200)).toBe(500)
    expect(statusOf(new Error('boom'), undefined)).toBe(500)
    expect(statusOf(new Error('boom'), 200)).toBe(500)
  })

  it('keeps a written error status for an error carrying none', () => {
    expect(statusOf(new Error('boom'), 503)).toBe(503)
  })

  it('rejects a nonsense status rather than storing it', () => {
    const error = new Error('boom');
    (error as { statusCode?: number }).statusCode = 99_999

    expect(statusOf(error, 500)).toBe(500)
  })
})

describe('isFetchError', () => {
  it('recognises one by name', () => {
    expect(isFetchError(fetchError(422))).toBe(true)
  })

  it('recognises one wrapped as a cause', () => {
    // Nuxt rewraps a failed `$fetch` during SSR, so by the time the error hook
    // sees it the FetchError is often one layer down.
    const wrapper = new Error('Server Error');
    (wrapper as { cause?: Error }).cause = fetchError(422)

    expect(isFetchError(wrapper)).toBe(true)
  })

  it('leaves ordinary errors alone', () => {
    expect(isFetchError(new Error('boom'))).toBe(false)
    expect(isFetchError(h3Error(404))).toBe(false)
  })
})
