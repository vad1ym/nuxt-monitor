export default defineNuxtConfig({
  modules: ['nuxt-monitor'],

  monitor: {
    auth: {
      username: 'admin',
      // Read from the environment so the example can be built both with and
      // without a password — the no-password path is a behaviour worth testing.
      password: process.env.MONITOR_PASSWORD,
    },

    // Named parts of the application. `/api/throw` is deliberately watched so
    // the demo shows an alert that no ordinary trigger would have raised.
    groups: {
      payments: { routes: ['/api/checkout/**', '/api/reconcile'], notify: true },
      unstable: { routes: ['/api/throw', '/api/async-throw'], notify: true },
      // Pages, not just endpoints: the same rule shape matches a page URL, and
      // a client-side error carries the page it happened on.
      ui: { routes: ['/client-error', '/ssr-error', '/middleware-error'], notify: true },
      'third-party': { messages: ['upstream', 'ECONNREFUSED'] },
    },

    notifications: {
      // Declared without a URL on purpose: the channel is only usable once
      // `NUXT_MONITOR_NOTIFICATIONS_WEBHOOK_URL` is set when the server starts,
      // which is the path a real deployment takes with a bot token. Unset, the
      // channel is skipped and the example exercises the default install —
      // where nothing is configured and the screen has to say so.
      channels: [{ type: 'webhook', name: 'demo-hook' }],
      // Short, so a demo does not sit waiting on a window meant for real days.
      groupWindowSeconds: 2,
    },
  },

  compatibilityDate: '2025-01-01',
})
