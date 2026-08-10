import { defineNuxtPlugin } from '#imports'

/**
 * Server-render errors that never throw.
 *
 * When plugin application or an app lifecycle hook fails during SSR, Nuxt
 * catches it, calls `app:error` and puts it in the payload — the request still
 * succeeds, so Nitro's `error` hook never sees it. Without this the failure
 * would be invisible on the server side.
 *
 * The client half of this is handled by `collector.client`, so this only acts
 * during SSR.
 */
export default defineNuxtPlugin({
  name: 'monitor:collector-ssr',
  enforce: 'pre',

  setup(nuxtApp) {
    if (!import.meta.server) {
      return
    }

    const report = (error: unknown, tag: string): void => {
      const event = nuxtApp.ssrContext?.event

      // Reported through Nitro's own channel so there is a single capture
      // path. A render error that also propagates out of the handler arrives
      // there twice; the collector de-duplicates by error identity.
      //
      // Passed through unwrapped: re-creating it would replace the real
      // constructor name, and that name is part of how issues are grouped.
      event?.captureError?.(error as Error, { tags: ['nuxt', tag] })
    }

    nuxtApp.hook('app:error', error => report(error, 'app:error'))
    nuxtApp.hook('vue:error', error => report(error, 'vue:error'))
  },
})
