export default defineNuxtConfig({
  modules: ['nuxt-monitor'],

  monitor: {
    auth: {
      username: 'admin',
      // Read from the environment so the example can be built both with and
      // without a password — the no-password path is a behaviour worth testing.
      password: process.env.MONITOR_PASSWORD,
    },

    /**
     * Bodies, both halves.
     *
     * The request half is off by default and turned on here deliberately: a
     * checkout posts a basket, and "Basket contains a product that is no
     * longer in the catalogue" is a different investigation depending on which
     * product. The card token that rides along in the headers proves the other
     * half of the point — it is redacted before anything is stored.
     */
    capture: { request: true },

    /**
     * Named parts of the shop.
     *
     * Written the way the files under `server/api` are named, because that is
     * the point: a failure in checkout belongs to payments whether or not
     * anybody remembered to call `exception()` with a group, and the name is
     * then what an alert channel subscribes to and what the issue list filters
     * by.
     */
    groups: {
      // First on purpose. The first matching rule wins, and this one is
      // deliberately placed above `payments` because a provider outage on
      // `/api/checkout/pay` matches both — and "Stripe is down" and "our
      // checkout is broken" send different people out of bed. Matched on the
      // message rather than the path, which is the only thing that works for a
      // provider: they rarely break on their own route, they break inside
      // yours.
      'third-party': { messages: ['upstream', 'ECONNREFUSED', 'stripe'], notify: true },
      // Money. Alerted on, because a checkout that is down is a shop that is
      // closed.
      payments: { routes: ['/api/checkout/**'], notify: true },
      // The catalogue is where a bad row shows up. Worth a label, not worth a
      // phone call: a single product failing is not the shop being down.
      catalog: { routes: ['/api/catalog/**', '/product/**'] },
      // The back office. Nobody is buying anything here, so it is watched
      // rather than alerted on.
      admin: { routes: ['/api/admin/**', '/admin'] },
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
