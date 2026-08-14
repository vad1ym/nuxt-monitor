import { useNuxtApp } from '#imports'
import type { MonitorExceptionOptions } from '../../types'
import type { ClientEvent } from './queue'
import {
  EXCEPTION_TYPE,
  callSiteStack,
  normalizeGroup,
  normalizeLevel,
} from '../shared/exception'

/**
 * Reporting something that did not throw.
 *
 * Plenty of what is worth knowing about never becomes an exception: a payment
 * total that does not reconcile, an invariant that no longer holds, a third
 * party answering 200 with nonsense. Code like that already has a branch for
 * the bad case — what it lacks is anywhere to say so.
 *
 * Deliberately narrow. This is not a logger: every call becomes an issue with
 * a fingerprint, a history and, if configured, an alert. Things that happen
 * routinely belong in logs (#12), and mixing the two would make the issue list
 * exactly as skimmable as a log file.
 */
export function useMonitor(): {
  exception: (message: string, options?: MonitorExceptionOptions) => void
  identify: (id: string | undefined) => void
} {
  const nuxtApp = useNuxtApp()

  return {
    /**
     * Attaches an opaque account identifier to this tab's errors.
     *
     * The one piece of personal data this module will hold, and only because
     * the application chose to hand it over. Nothing here collects it: the
     * session id everything else uses is random, per-tab and joinable to
     * nothing, which is what keeps the default outside the definition of
     * tracking. This is the escape hatch for the question that identity
     * genuinely answers and anonymity cannot — *how many customers*, not how
     * many tabs. Three affected sessions is one developer with three windows
     * open or three people who cannot check out, and only the application
     * knows which.
     *
     * Opaque on purpose. Pass an account id, not an email or a name: it lands
     * in a database whose whole selling point is that it lives on your own
     * disk with no processor agreement behind it, and the value only has to be
     * stable enough to count distinct people and to find one who complained.
     * Anything more identifying is a liability the feature does not need.
     *
     * `undefined` clears it, which is what a sign-out must call. Not persisted
     * anywhere — it lives in memory for the life of the tab, so it cannot
     * outlive the session it describes or be read back on a later visit.
     */
    identify(id: string | undefined): void {
      const setter = nuxtApp.$monitorIdentify as ((value: string | undefined) => void) | undefined

      setter?.(typeof id === 'string' && id.trim() ? id.trim().slice(0, 64) : undefined)
    },

    exception(message: string, options: MonitorExceptionOptions = {}): void {
      // An empty message would produce an issue nobody can act on or even
      // describe — and, since the message is part of the fingerprint, every
      // such call would land in the same one.
      if (typeof message !== 'string' || !message.trim()) {
        return
      }

      const event: ClientEvent = {
        type: EXCEPTION_TYPE,
        message: message.trim(),
        timestamp: Date.now(),
        // Taken here, at the call site, and not inside the reporter: two more
        // frames of ours on top would be two more frames between the report
        // and the line that made it.
        stack: callSiteStack(),
        manual: true,
        level: normalizeLevel(options.level),
        group: normalizeGroup(options.group),
        context: options.meta && typeof options.meta === 'object'
          ? { ...options.meta }
          : undefined,
      }

      // Server-side, including during SSR: the collector plugin is client-only,
      // so there is nothing to report through and the event goes straight to
      // the store. `$monitorReport` is absent there by construction.
      const report = nuxtApp.$monitorReport as ((event: ClientEvent) => void) | undefined

      if (report) {
        report(event)
        return
      }

      // Never let a report take down the thing it was reporting from. Reaching
      // here means either SSR — handled below — or a build with the collector
      // switched off, where doing nothing is the correct outcome.
      try {
        reportDuringSsr(event, nuxtApp)
      }
      catch {
        // A failed report stays a failed report; it does not become a second
        // error for somebody else to investigate.
      }
    },
  }
}

/**
 * Delivery during server rendering.
 *
 * The collector plugin is client-only, so there is no queue here — the event
 * goes to the process-wide store the Nitro error hook writes to, which is what
 * makes an `exception()` in a server route and one in a component's `setup`
 * land in the same place.
 *
 * The import is dynamic and guarded so that the server-only module — and the
 * database behind it — is never reachable from the browser bundle.
 */
function reportDuringSsr(event: ClientEvent, nuxtApp: ReturnType<typeof useNuxtApp>): void {
  if (!import.meta.server) {
    return
  }

  const request = nuxtApp.ssrContext?.event
  const context = request
    ? { url: request.path, method: request.method, ...event.context }
    : event.context

  void import('../server/context').then(({ captureSync }) => {
    captureSync({
      side: 'server',
      type: EXCEPTION_TYPE,
      message: event.message,
      stack: event.stack,
      timestamp: event.timestamp,
      context,
      manual: true,
      level: event.level,
      group: event.group,
      tags: ['monitor', 'exception'],
    })
  }).catch(() => {})
}
