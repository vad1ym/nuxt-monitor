import type { Ref } from 'vue'
import { useState } from '#imports'

export interface BasketLine {
  slug: string
  quantity: number
}

/**
 * The basket, in memory.
 *
 * `restore()` is the interesting one: it reads a basket the browser has been
 * carrying since a previous version of the site, in a shape this version no
 * longer writes. That is the most common client-side error there is, and the
 * only way to see it is to have code that trusts its own stored state.
 */
export function useBasket(): {
  lines: Ref<BasketLine[]>
  add: (slug: string) => void
  clear: () => void
} {
  const lines = useState<BasketLine[]>('basket', () => [])

  function add(slug: string): void {
    const existing = lines.value.find(line => line.slug === slug)

    if (existing) {
      existing.quantity += 1
      return
    }

    lines.value.push({ slug, quantity: 1 })
  }

  function clear(): void {
    lines.value = []
  }

  return { lines, add, clear }
}
