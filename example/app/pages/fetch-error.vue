<script setup lang="ts">
/**
 * A failing `useFetch`, which is how most data errors reach a real app.
 *
 * The fetch runs on the server during SSR, so the underlying API error is
 * captured server-side and the failure surfaces here as data.
 */
const { data, error } = await useFetch('/api/create-error')
</script>

<template>
  <section>
    <p v-if="error">
      The request failed with <code>{{ error.statusCode }}</code>:
      {{ error.statusMessage }}
    </p>
    <pre v-else>{{ data }}</pre>
  </section>
</template>
