<script setup lang="ts">
/**
 * The project mark, as geometry rather than a bitmap.
 *
 * The logo exists as a 122 KB PNG for the docs site, which is the wrong thing
 * to inline into a dashboard that renders it at twenty pixels. Redrawn as
 * paths: a few hundred bytes, sharp at any size, and it takes its colour from
 * `currentColor` so the sidebar controls it like any other icon.
 */
</script>

<template>
  <svg
    viewBox="0 0 64 42"
    fill="none"
    stroke="currentColor"
    stroke-width="4.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- The frame, opened at the foot so the pulse can cross it. -->
    <path d="M24 39H9a6 6 0 0 1-6-6V9a6 6 0 0 1 6-6h46a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H44" />

    <!-- Two peaks: the left one hollow, the right one a plain chevron. -->
    <path d="M30 5 16.5 28.5h11L38 12" />
    <path d="M36 22.5 44 11l11 17.5" />

    <!-- The trace along the bottom edge, which is what makes it a monitor. -->
    <path d="M24 39h5l3.5 -8 4 12 3-4h4.5" />
  </svg>
</template>
