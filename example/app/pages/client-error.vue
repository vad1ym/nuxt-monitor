<script setup lang="ts">
import { ref } from 'vue'

/**
 * A component error raised *after* hydration.
 *
 * This is the regression case for client collection: Nuxt removes its own Vue
 * error handler once the app hydrates, so anything listening only to
 * `app:error` stops seeing errors from this point on. It has to arrive through
 * `vue:error`.
 */
const item = ref<{ label: string } | null>(null)
const failed = ref(false)

function breakRender(): void {
  failed.value = true
}
</script>

<template>
  <section>
    <p>
      The button raises an error during re-render, after hydration has
      finished.
    </p>

    <button @click="breakRender">
      Break the render
    </button>

    <!-- Reads through a null once `failed` flips, throwing inside render. -->
    <p v-if="failed">
      {{ item!.label.toUpperCase() }}
    </p>
  </section>
</template>
