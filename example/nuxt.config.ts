export default defineNuxtConfig({
  modules: ['nuxt-monitor'],

  monitor: {
    auth: {
      username: 'admin',
      // Read from the environment so the example can be built both with and
      // without a password — the no-password path is a behaviour worth testing.
      password: process.env.MONITOR_PASSWORD,
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
