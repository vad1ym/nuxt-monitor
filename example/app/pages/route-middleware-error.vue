<script setup lang="ts">
/**
 * Fails inside route middleware, which runs during navigation — before the
 * component exists. On first load this happens on the server; on client-side
 * navigation it happens in the browser.
 */
definePageMeta({
  middleware: [
    () => {
      const permissions = undefined as string[] | undefined

      // Throws here — the point of the page. Nothing follows, because nothing
      // reaches it.
      permissions!.includes('admin')
    },
  ],
})
</script>

<template>
  <p>If you can read this, the middleware error did not fire.</p>
</template>
