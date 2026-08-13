<script setup lang="ts">
import { formatPrice } from '../utils/format'

/**
 * The shop front.
 *
 * A page that works, listing products that mostly work — which is the point:
 * an example where every link is a landmine teaches nothing about a tool whose
 * whole job is to find the few things that are broken among the many that are
 * not. The failures are reachable from here, in the places a customer would
 * reach them.
 */
const { data } = await useFetch('/api/catalog')
</script>

<template>
  <div>
    <p class="lede">
      A very small shop. Buy something, or open
      <a href="/_monitor">/_monitor</a> to see what broke while you tried.
    </p>

    <ul class="products">
      <li v-for="product in data?.products" :key="product.slug">
        <NuxtLink :to="`/product/${product.slug}`">
          {{ product.title }}
        </NuxtLink>
        <span class="price">{{ formatPrice(product.price) }}</span>
        <span v-if="!product.inStock" class="tag">out of stock</span>
      </li>
    </ul>

    <p class="note">
      <NuxtLink to="/cart">
        Basket
      </NuxtLink>
      ·
      <NuxtLink to="/admin">
        Admin
      </NuxtLink>
    </p>
  </div>
</template>

<style scoped>
.products {
  padding: 0;
  margin: 1.5rem 0;
  list-style: none;
}

.products li {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.6rem 0;
  border-bottom: 1px solid #e4e4e7;
}

.price {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: #52525b;
}

.tag {
  padding: 0.1rem 0.4rem;
  font-size: 0.75rem;
  color: #b45309;
  background: #fef3c7;
  border-radius: 0.25rem;
}

.note {
  font-size: 0.875rem;
  color: #71717a;
}
</style>
