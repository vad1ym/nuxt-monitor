import { defineConfig } from 'vitepress'

/**
 * The documentation site.
 *
 * Ordered by when a reader needs each page rather than by topic: install,
 * then the two things that decide whether this is usable in production —
 * authentication and sourcemaps — then everything you tune afterwards, then
 * the honest account of what it does not do.
 */
export default defineConfig({
  title: 'nuxt-monitor',
  description: 'Local-first error monitoring for Nuxt. No DSN, no account, no sourcemap upload.',
  cleanUrls: true,
  lastUpdated: true,

  /**
   * The site is served from a repository subpath, not the root of a domain.
   *
   * Every asset VitePress emits is referenced absolutely — `/assets/app.js` —
   * so without this they resolve against `vad1ym.github.io` rather than
   * `vad1ym.github.io/nuxt-monitor`, and the deployed page loads its HTML and
   * nothing else. The failure is silent locally, where the dev server does
   * serve from the root.
   */
  base: '/nuxt-monitor/',

  // Spelled with the base included: `head` is emitted verbatim, unlike the
  // links VitePress rewrites for you.
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/nuxt-monitor/favicon.png' }],
  ],

  themeConfig: {
    logo: '/logo.png',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Config', link: '/config/' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Authentication', link: '/guide/authentication' },
          { text: 'Sourcemaps', link: '/guide/sourcemaps' },
          { text: 'Notifications', link: '/guide/notifications' },
          { text: 'Reporting by hand', link: '/guide/reporting' },
          { text: 'Grouping', link: '/guide/grouping' },
          { text: 'Privacy', link: '/guide/privacy' },
          { text: 'Storage', link: '/guide/storage' },
          { text: 'Uptime', link: '/guide/uptime' },
          { text: 'CLI and export', link: '/guide/cli' },
          { text: 'Deployment', link: '/guide/deployment' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/config/' },
          { text: 'API', link: '/config/api' },
        ],
      },
    ],

    search: { provider: 'local' },

    footer: {
      message: 'Released under the MIT License.',
    },
  },
})
