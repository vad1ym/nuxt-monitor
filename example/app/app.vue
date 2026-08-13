<template>
  <div class="page">
    <header class="head">
      <h1>
        <NuxtLink to="/">
          Desk Supply Co.
        </NuxtLink>
      </h1>
      <nav>
        <NuxtLink to="/cart">
          Basket
        </NuxtLink>
        <NuxtLink to="/admin">
          Admin
        </NuxtLink>
        <a href="/_monitor">Monitor</a>
      </nav>
    </header>

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

.head {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 1rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid #e4e4e7;
}

h1 {
  margin: 0;
  font-size: 1.25rem;
}

h1 a {
  color: inherit;
  text-decoration: none;
}

nav {
  display: flex;
  gap: 1rem;
  font-size: 0.875rem;
}

.lede {
  color: #52525b;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1rem 0;
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

button:hover:not(:disabled) {
  background: #f4f4f5;
}

button:disabled {
  color: #a1a1aa;
  cursor: not-allowed;
}
</style>
