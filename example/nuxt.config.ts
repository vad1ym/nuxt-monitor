export default defineNuxtConfig({
  modules: ['nuxt-monitor'],

  monitor: {
    auth: {
      username: 'admin',
      // Read from the environment so the example can be built both with and
      // without a password — the no-password path is a behaviour worth testing.
      password: process.env.MONITOR_PASSWORD,
    },
  },

  compatibilityDate: '2025-01-01',
})
