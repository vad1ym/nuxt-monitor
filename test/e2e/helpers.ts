import { $fetch, fetch as nuxtFetch, url } from '@nuxt/test-utils/e2e'
import type { MonitorIssue } from '../../lib/types'

export const PASSWORD = 'test-password'

/**
 * Raw request against the running server.
 *
 * `$fetch` unwraps the body and throws on non-2xx, which hides exactly what
 * the security assertions need to see — status codes and `set-cookie`.
 */
export async function raw(
  path: string,
  init: RequestInit & { body?: unknown } = {},
): Promise<Response> {
  const { body, headers, ...rest } = init

  // Mutating endpoints check `Origin`, which a browser always sends and a bare
  // fetch does not. Supplying it here keeps these tests exercising the paths a
  // real dashboard takes; the checks themselves are tested by omitting it.
  const origin = new URL(url('/')).origin

  return nuxtFetch(path, {
    ...rest,
    headers: body === undefined
      ? { origin, ...headers }
      : { 'content-type': 'application/json', 'origin': origin, ...headers },
    body: body === undefined || typeof body === 'string' ? body as string : JSON.stringify(body),
    redirect: 'manual',
  })
}

/** Signs in and returns the cookie header to reuse for authenticated calls. */
export async function login(password = PASSWORD): Promise<string> {
  const response = await raw('/_monitor/api/login', {
    method: 'POST',
    body: { username: 'admin', password },
  })

  if (!response.ok) {
    throw new Error(`login failed with ${response.status}`)
  }

  const setCookie = response.headers.getSetCookie?.()[0]
    ?? response.headers.get('set-cookie')
    ?? ''

  const value = setCookie.split(';')[0]

  if (!value) {
    throw new Error('login did not return a session cookie')
  }

  return value
}

/**
 * Polls until a matching issue appears.
 *
 * Events are buffered in memory and flushed in batches, so a capture is not
 * visible the instant the request that caused it returns. Polling keeps the
 * tests honest about that without hard-coding a sleep long enough to be slow
 * and short enough to be flaky.
 */
export async function waitForIssue(
  cookie: string,
  predicate: (issue: MonitorIssue) => boolean,
  query: { resolved?: boolean } = {},
  timeoutMs = 10_000,
): Promise<MonitorIssue> {
  const deadline = Date.now() + timeoutMs
  const suffix = query.resolved === undefined ? '' : `&resolved=${query.resolved}`

  let last: MonitorIssue[] = []

  while (Date.now() < deadline) {
    const { issues } = await $fetch<{ issues: MonitorIssue[] }>(
      `/_monitor/api/issues?limit=100${suffix}`,
      { headers: { cookie } },
    )

    last = issues

    const found = issues.find(predicate)

    if (found) {
      return found
    }

    await new Promise(resolve => setTimeout(resolve, 200))
  }

  throw new Error(
    `no issue matched within ${timeoutMs}ms. Present: ${
      last.map(i => `${i.side}/${i.type}: ${i.message}`).join(' | ') || '(none)'
    }`,
  )
}
