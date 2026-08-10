<script setup lang="ts">
/**
 * Index of the error cases. Each link triggers one distinct capture path, so a
 * change to collection can be checked against every path it should cover.
 */
const serverCases = [
  { path: '/api/throw', label: 'API route: plain throw' },
  { path: '/api/create-error', label: 'API route: createError with statusCode' },
  { path: '/api/not-found', label: 'API route: 404 (ignored by default)' },
  { path: '/api/async-throw', label: 'API route: rejected promise' },
  { path: '/api/scrub-me?token=leaked', label: 'API route: secrets in headers and query' },
  { path: '/middleware-error', label: 'Server middleware' },
  { path: '/ssr-error', label: 'SSR render' },
]

const clientCases = [
  { path: '/client-error', label: 'Component error after hydration' },
  { path: '/route-middleware-error', label: 'Route middleware' },
  { path: '/fetch-error', label: 'useFetch against a failing route' },
]

function throwInHandler(): void {
  throw new Error('Thrown from a click handler')
}

function rejectPromise(): void {
  void Promise.reject(new Error('Unhandled rejection from a click'))
}

function throwInTimer(): void {
  setTimeout(() => {
    throw new Error('Thrown from a timer')
  }, 0)
}
</script>

<template>
  <div>
    <h2>Server</h2>
    <ul>
      <li v-for="item in serverCases" :key="item.path">
        <a :href="item.path">{{ item.label }}</a>
      </li>
    </ul>

    <h2>Client</h2>
    <ul>
      <li v-for="item in clientCases" :key="item.path">
        <NuxtLink :to="item.path">
          {{ item.label }}
        </NuxtLink>
      </li>
    </ul>

    <h2>In-page</h2>
    <p>
      These fire without navigating, which is how most real client errors
      happen.
    </p>
    <div class="row">
      <button @click="throwInHandler">
        Event handler
      </button>
      <button @click="rejectPromise">
        Unhandled rejection
      </button>
      <button @click="throwInTimer">
        Timer
      </button>
    </div>
  </div>
</template>
