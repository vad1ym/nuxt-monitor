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

  themeConfig: {
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
          { text: 'Releases', link: '/guide/releases' },
          { text: 'Grouping', link: '/guide/grouping' },
          { text: 'Privacy', link: '/guide/privacy' },
          { text: 'Storage', link: '/guide/storage' },
          { text: 'Deployment', link: '/guide/deployment' },
          { text: 'Coming from Sentry', link: '/guide/from-sentry' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/config/' },
          { text: 'CLI', link: '/config/cli' },
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
