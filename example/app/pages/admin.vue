<script setup lang="ts">
import { ref } from 'vue'

/**
 * The back office.
 *
 * Guarded by route middleware that reads a permission list it does not have —
 * which fails during navigation, before the component exists. On a first load
 * that happens on the server; on a client-side navigation from the shop front
 * it happens in the browser. One bug, captured from two sides, which is the
 * case that made a `side` column necessary in the first place.
 */
definePageMeta({
  middleware: [
    () => {
      const session = useState<{ permissions?: string[] } | null>('session', () => null)

      // The session was never loaded, so this reads through a null. A guard
      // that assumes it ran after the thing it depends on is a bug that only
      // fires on a direct visit.
      if (!session.value!.permissions!.includes('admin')) {
        return navigateTo('/')
      }
    },
  ],
})

const output = ref('')

async function run(path: string): Promise<void> {
  output.value = 'Running…'
  output.value = JSON.stringify(await $fetch(path), null, 2)
}
</script>

<template>
  <section>
    <h2 class="title">
      Back office
    </h2>

    <div class="row">
      <button @click="run('/api/admin/reconcile')">
        Reconcile the ledger
      </button>
      <button @click="run('/api/admin/report')">
        Daily report
      </button>
      <button @click="run('/api/admin/export?token=leaked-secret')">
        Export to the warehouse
      </button>
      <button @click="run('/api/admin/bulk')">
        Bulk update
      </button>
    </div>

    <pre v-if="output">{{ output }}</pre>
  </section>
</template>

<style scoped>
.title {
  font-size: 1.25rem;
}

pre {
  padding: 0.75rem;
  overflow-x: auto;
  font-size: 0.8125rem;
  background: #f4f4f5;
  border-radius: 0.375rem;
}
</style>
