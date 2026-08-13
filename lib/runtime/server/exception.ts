import type { H3Event } from 'h3'
import type { MonitorExceptionOptions } from '../../types'
import {
  EXCEPTION_TYPE,
  callSiteStack,
  normalizeGroup,
  normalizeLevel,
} from '../shared/exception'
import { scrub } from '../shared/scrub'
import { captureSync, monitorConfig } from './context'

/**
 * Reporting something that did not throw, from server code.
 *
 * The counterpart of `useMonitor().exception()`, and a separate entry point
 * because most of these calls belong in a server route or a task, where there
 * is no Nuxt app to reach a composable through. Both produce the same event,
 * so where a report was made from does not change which issue it joins.
 *
 * ```ts
 * export default defineEventHandler(async (event) => {
 *   const charge = await settle(order)
 *
 *   if (charge.total !== order.total) {
 *     exception('Charged total does not match the order', {
 *       level: 'critical',
 *       group: 'payments',
 *       meta: { order: order.id },
 *     }, event)
 *   }
 * })
 * ```
 *
 * Passing the `H3Event` is optional and worth doing: it attaches the route and
 * method, which is the difference between "totals disagree" and "totals
 * disagree on POST /checkout".
 */
export function exception(
  message: string,
  options: MonitorExceptionOptions = {},
  event?: H3Event,
): void {
  // An empty message makes an issue nobody can act on, and — since the message
  // is part of the fingerprint — every such call would land in the same one.
  if (typeof message !== 'string' || !message.trim()) {
    return
  }

  try {
    const config = monitorConfig()
    const meta = options.meta && typeof options.meta === 'object'
      // Scrubbed like any other captured context. A hand-written report is
      // more likely to carry a whole object from the surrounding code, not
      // less, and the same keys are secret wherever they come from.
      ? scrub({ ...options.meta }, { extraKeys: config.scrubKeys })
      : undefined

    captureSync({
      side: 'server',
      type: EXCEPTION_TYPE,
      message: message.trim(),
      // Skips this function and its caller, so the top frame is the line that
      // made the report rather than one inside nuxt-monitor — which, being
      // part of the fingerprint, would group every manual report in the
      // application into a single issue.
      stack: callSiteStack(),
      timestamp: Date.now(),
      context: {
        ...(event ? { url: event.path, method: event.method } : {}),
        ...meta,
      },
      manual: true,
      level: normalizeLevel(options.level),
      group: normalizeGroup(options.group),
      tags: ['monitor', 'exception'],
    })
  }
  catch {
    // Reporting a problem must never become a problem of its own.
  }
}
