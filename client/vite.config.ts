import { fileURLToPath } from 'node:url'
import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * The dashboard is built here and shipped prebuilt inside the package.
 *
 * Building it separately is what keeps it out of the consuming app: Nuxt UI
 * and Tailwind are our build-time dependencies, not the user's. They install
 * `nuxt-monitor` and get a finished bundle — no peer dependencies, no Tailwind
 * `@source` line to remember, no effect on their own styles or bundle size.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),

  plugins: [
    vue(),
    ui({
      // Nuxt UI's own defaults: green primary on a zinc neutral ramp.
      ui: {
        colors: {
          primary: 'green',
          neutral: 'zinc',
        },
      },
      // No switcher and no preference tracking: the dashboard is dark, and
      // `dark` on <html> is all that decides it.
      colorMode: false,
    }),
  ],

  // Relative asset URLs, so the SPA works whatever route it is mounted at.
  base: './',

  build: {
    outDir: fileURLToPath(new URL('../dist/client', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
})
