<script setup lang="ts">
import { useBasket } from '../../composables/useBasket'
import { formatPrice } from '../../utils/format'

/**
 * A product page, rendered on the server.
 *
 * `cable-tray` fails here — the row has no `dimensions`, and the endpoint
 * reads through them. Because the fetch runs during SSR, the fault is captured
 * server-side and the page falls back to an error state, which is the two-part
 * behaviour worth having in an example: one error, two places it shows up.
 */
const route = useRoute()
const { add } = useBasket()

const { data: product, error } = await useFetch(() => `/api/catalog/${route.params.slug}`)
</script>

<template>
  <section>
    <p v-if="error" class="error">
      This product could not be loaded ({{ error.statusCode }}).
      <NuxtLink to="/">
        Back to the shop
      </NuxtLink>
    </p>

    <template v-else-if="product">
      <h2 class="title">
        {{ product.title }}
      </h2>
      <p class="price">
        {{ formatPrice(product.price) }}
      </p>

      <div class="row">
        <button :disabled="product.stock === 0" @click="add(product.slug)">
          {{ product.stock ? 'Add to basket' : 'Out of stock' }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.title {
  margin-bottom: 0.25rem;
  font-size: 1.25rem;
}

.price {
  margin: 0 0 1rem;
  color: #52525b;
}

.error {
  color: #b91c1c;
}
</style>
