<script setup lang="ts">
import { ref } from 'vue'
import { useBasket } from '../composables/useBasket'
import { formatPrice } from '../utils/format'

/**
 * The basket, and the three ways a checkout goes wrong in the browser.
 *
 * Every button here is something a customer does, not a labelled error case.
 * That distinction is the whole reason for rewriting this example: an issue
 * list reading "Thrown from a click handler" teaches nothing, and one reading
 * "Cannot read properties of undefined (reading 'total')" on `/cart` is a
 * morning's work for somebody.
 */
const { lines, add, clear } = useBasket()

const quote = ref<{ total: number, currency: string } | null>(null)
const status = ref('')
const legacy = ref(false)

/** Prices the basket. Fails when the basket holds something withdrawn. */
async function priceBasket(): Promise<void> {
  status.value = ''

  const answer = await $fetch<{ total: number, currency: string }>('/api/checkout/quote', {
    method: 'POST',
    body: { lines: lines.value },
  })

  quote.value = answer
}

/**
 * Pays, then confirms.
 *
 * The provider is down for one attempt in five, which surfaces here as a
 * rejected `$fetch` — a client-side error whose cause is a server-side one,
 * and the pair is worth seeing linked in the dashboard.
 */
async function pay(): Promise<void> {
  status.value = 'Charging…'

  const order = await $fetch<{ orderId: string }>('/api/checkout/pay', {
    method: 'POST',
    body: { lines: lines.value },
    // A card token, to prove it never reaches the stored event.
    headers: { 'x-card-token': 'tok_live_4242424242424242' },
  })

  await $fetch('/api/checkout/confirm', {
    method: 'POST',
    body: { orderId: order.orderId },
  })

  status.value = `Order ${order.orderId} placed.`
  clear()
}

/**
 * Restores a basket saved by an older version of the site.
 *
 * The old shape stored `{ items }`; this one stores `{ lines }`. Reading
 * through the field that is no longer there throws during render — after
 * hydration, which is the path that only `vue:error` sees.
 */
function restoreLegacyBasket(): void {
  legacy.value = true
}

const saved = { items: undefined } as { items?: { slug: string, quantity: number }[] }
</script>

<template>
  <section>
    <h2 class="title">
      Basket
    </h2>

    <p v-if="!lines.length" class="empty">
      Nothing here yet.
      <NuxtLink to="/">
        Pick something
      </NuxtLink>.
    </p>

    <ul v-else class="lines">
      <li v-for="line in lines" :key="line.slug">
        <span>{{ line.slug }}</span>
        <span class="quantity">×{{ line.quantity }}</span>
      </li>
    </ul>

    <p v-if="quote" class="total">
      Total: {{ formatPrice(quote.total, quote.currency) }}
    </p>
    <p v-if="status" class="status">
      {{ status }}
    </p>

    <div class="row">
      <button @click="add('desk-lamp')">
        Add the out-of-stock lamp
      </button>
      <button @click="add('discontinued-rug')">
        Add a withdrawn product
      </button>
      <button @click="priceBasket">
        Price the basket
      </button>
      <button @click="pay">
        Pay
      </button>
      <button @click="restoreLegacyBasket">
        Restore a saved basket
      </button>
    </div>

    <!-- Reads through `items`, which this version never writes. Throws during
         re-render once `legacy` flips. -->
    <p v-if="legacy" class="note">
      Restored {{ saved.items!.length }} saved line(s).
    </p>
  </section>
</template>

<style scoped>
.title {
  font-size: 1.25rem;
}

.lines {
  padding: 0;
  margin: 1rem 0;
  list-style: none;
}

.lines li {
  display: flex;
  gap: 0.75rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid #e4e4e7;
}

.quantity {
  margin-left: auto;
  color: #71717a;
}

.total {
  font-weight: 600;
}

.status,
.empty,
.note {
  color: #52525b;
}
</style>
