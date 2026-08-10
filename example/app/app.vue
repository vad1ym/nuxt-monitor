<template>
  <div class="page">
    <h1>
      <NuxtLink to="/">
        nuxt-monitor example
      </NuxtLink>
    </h1>
    <p class="lede">
      Trigger a few errors, then open <a href="/_monitor">/_monitor</a> to see how
      they were captured.
    </p>

    <NuxtPage />
  </div>
</template>

<style>
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, sans-serif;
  line-height: 1.5;
  color: #18181b;
  background: #fafafa;
}

.page {
  max-width: 44rem;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
}

h1 {
  margin-bottom: 0.25rem;
  font-size: 1.5rem;
}

h1 a {
  color: inherit;
  text-decoration: none;
}

h2 {
  margin-top: 2rem;
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #71717a;
}

.lede {
  color: #52525b;
}

ul {
  padding-left: 1.25rem;
}

li {
  margin: 0.35rem 0;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

button {
  padding: 0.5rem 0.85rem;
  font: inherit;
  color: #18181b;
  cursor: pointer;
  background: #fff;
  border: 1px solid #d4d4d8;
  border-radius: 0.375rem;
}

button:hover {
  background: #f4f4f5;
}
</style>
