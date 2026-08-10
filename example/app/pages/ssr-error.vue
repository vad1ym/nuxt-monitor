<script setup lang="ts">
/**
 * Fails during server render, before any HTML is produced. The throw happens
 * in setup on the server only, so it reaches Nitro rather than the browser.
 */
if (import.meta.server) {
  const settings = null as { theme: string } | null

  // Reading through a null during SSR — a very common real failure.
  useHead({ title: settings!.theme })
}
</script>

<template>
  <p>If you can read this, the SSR error did not fire.</p>
</template>
