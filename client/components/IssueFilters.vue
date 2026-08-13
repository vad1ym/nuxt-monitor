<script setup lang="ts">
import { computed } from 'vue'
import type { MonitorFacetCounts, MonitorFacetFilter, MonitorFacetName } from '../../lib/types'
import { formatShare } from '../chart'

/**
 * Filters, above the list they act on.
 *
 * They used to be a column in the sidebar, which put a control that narrows
 * the list beside the links that change the screen — and crowded out anything
 * else the sidebar might carry. Here they are a row of dropdowns: closed they
 * take one line, open they show the same counts and bars as before.
 *
 * Active values stay visible on the closed control, because a filter you
 * cannot see is a filter you cannot undo.
 */
type Choices = Record<string, { label: string, icon: string }>

const props = defineProps<{
  facets: MonitorFacetCounts | null
  /** What we have decided about the issue: open, resolved, ignored. */
  statuses: Choices
  /** What sort of thing failed: an endpoint or a page. */
  kinds: Choices
  /** Where it ran, and how we found out. */
  origins: Choices
  /** Order names, keyed by the value the API takes. */
  sorts: Record<string, string>
}>()

/** Widening a cut-off value list is the parent's fetch to make, not this one's. */
const emit = defineEmits<{ expand: [] }>()

const model = defineModel<MonitorFacetFilter>({ required: true })

/**
 * The three narrowings, each its own control.
 *
 * One row of eight buttons — Open, API, Pages, Server, Client, Reported,
 * Resolved, All, Ignored — rendered as a single enum and read as one. It was
 * not: those are three unrelated dimensions sharing one key, so choosing "API"
 * silently discarded "Open" and mixed resolved issues back in. Nobody asks for
 * that; it was an artefact of the control.
 *
 * Three dropdowns instead, which combine: "open API failures on the server" is
 * one sentence and three clicks that do not fight each other. They live here
 * rather than in the sidebar because "open issues" and "issues on iOS" are the
 * same kind of question, and answering one from a menu and the other from a
 * dropdown made the sidebar look like five screens that are really one.
 */
const status = defineModel<string>('status', { required: true })
const type = defineModel<string>('type', { required: true })
const origin = defineModel<string>('origin', { required: true })

/**
 * Which end of the list is the top.
 *
 * Sits with the filters rather than over the list itself: "the frequent ones,
 * on iOS" is a single question, and splitting its halves across two places
 * would make the second one look like it belongs to something else.
 */
const sort = defineModel<string>('sort', { required: true })

/**
 * The three controls, as data.
 *
 * Built here rather than written out three times in the template: they differ
 * only in which options they offer and which model they set, and three
 * near-identical popovers is where the next one quietly drifts from the other
 * two.
 *
 * `active` decides whether the button is highlighted, and it is deliberately
 * *not* "has a value" — each of these always has one. It is "has a value other
 * than the one that narrows nothing", so the row shows at a glance which of
 * the three are actually doing something.
 */
const choices = computed(() => [
  {
    key: 'status',
    options: props.statuses,
    value: status.value,
    set: (value: string) => { status.value = value },
    active: status.value !== 'open',
    label: props.statuses[status.value]?.label ?? 'Status',
    icon: props.statuses[status.value]?.icon ?? 'i-lucide-inbox',
  },
  {
    key: 'type',
    options: props.kinds,
    value: type.value,
    set: (value: string) => { type.value = value },
    active: type.value !== 'any',
    label: props.kinds[type.value]?.label ?? 'Any type',
    icon: props.kinds[type.value]?.icon ?? 'i-lucide-shapes',
  },
  {
    key: 'origin',
    options: props.origins,
    value: origin.value,
    set: (value: string) => { origin.value = value },
    active: origin.value !== 'any',
    label: props.origins[origin.value]?.label ?? 'Anywhere',
    icon: props.origins[origin.value]?.icon ?? 'i-lucide-globe',
  },
])

/**
 * Kept to one line's worth.
 *
 * `route` is deliberately absent even though it is filterable: it has a screen
 * of its own, its values are the longest here, and a control row that wraps
 * costs more than the filter is worth. It still applies when a section hands
 * one over — the chip appears then, because a filter you cannot see is a
 * filter you cannot undo.
 */
const GROUPS: { name: MonitorFacetName, label: string, icon: string }[] = [
  // First: it is the one dimension somebody named themselves, either at an
  // `exception()` call or in a config rule. The others describe whoever
  // happened to hit the fault; this one says what the fault is about.
  { name: 'group', label: 'Group', icon: 'i-lucide-flag' },
  { name: 'browser', label: 'Browser', icon: 'i-lucide-globe' },
  { name: 'os', label: 'OS', icon: 'i-lucide-monitor' },
  { name: 'osVersion', label: 'OS version', icon: 'i-lucide-hash' },
  { name: 'deviceType', label: 'Device', icon: 'i-lucide-smartphone' },
  { name: 'release', label: 'Release', icon: 'i-lucide-tag' },
]

/** Filterable but not offered above; shown only once something sets it. */
const EXTRA: { name: MonitorFacetName, label: string, icon: string }[] = [
  { name: 'route', label: 'Route', icon: 'i-lucide-route' },
]

/**
 * A dimension with one value tells you nothing — everything is that value.
 * Hidden unless it is filtered on, so the row shows only what can be acted on.
 */
const groups = computed(() =>
  [...GROUPS, ...EXTRA]
    .map(group => ({
      ...group,
      values: props.facets?.[group.name]?.values ?? [],
      more: props.facets?.[group.name]?.more ?? false,
    }))
    .filter((group) => {
      // An active value always shows, whichever list it came from.
      if (model.value[group.name]?.length) {
        return true
      }

      return !EXTRA.some(extra => extra.name === group.name) && group.values.length > 1
    }),
)

const activeCount = computed(() =>
  Object.values(model.value).reduce((sum, values) => sum + (values?.length ?? 0), 0),
)

function selected(name: MonitorFacetName): string[] {
  return model.value[name] ?? []
}

/** Selecting is a toggle: the same click that adds a value removes it. */
function toggle(name: MonitorFacetName, value: string): void {
  const current = selected(name)
  const next = current.includes(value)
    ? current.filter(item => item !== value)
    : [...current, value]

  const updated = { ...model.value }

  if (next.length) {
    updated[name] = next
  }
  else {
    // Dropped rather than left empty, so an untouched facet and a cleared one
    // produce the same request.
    delete updated[name]
  }

  model.value = updated
}

/** What the closed button says: the value itself when there is only one. */
function summary(name: MonitorFacetName, label: string): string {
  const active = selected(name)

  if (!active.length) {
    return label
  }

  return active.length === 1 ? active[0]! : `${label}: ${active.length}`
}
</script>

<template>
  <!-- Two rows, not one wrapping row.
       These are different kinds of control — the first decides which issues
       exist, the second narrows them by dimension — and in a single flow the
       wrap fell wherever the widths happened to land: the facets split across
       two lines with a couple of scopes stranded beside them. -->
  <div class="space-y-2">
    <!-- Three dropdowns rather than nine buttons. As one row they read as a
         single enum, which they never were: status, type and origin are
         unrelated questions, and sharing one key meant answering the second
         threw away the first. -->
    <div class="flex flex-wrap items-center gap-1.5">
      <UPopover v-for="choice in choices" :key="choice.key">
        <UButton
          size="xs"
          :color="choice.active ? 'primary' : 'neutral'"
          :variant="choice.active ? 'subtle' : 'outline'"
          :icon="choice.icon"
          :label="choice.label"
          trailing-icon="i-lucide-chevron-down"
        />

        <template #content>
          <ul class="w-48 p-1">
            <li v-for="(item, key) in choice.options" :key="key">
              <button
                type="button"
                class="w-full flex items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors cursor-pointer"
                :class="choice.value === key ? 'text-highlighted bg-elevated/60' : 'text-toned hover:bg-elevated/40'"
                :aria-pressed="choice.value === key"
                @click="choice.set(String(key))"
              >
                <UIcon :name="item.icon" class="size-3.5 shrink-0 text-dimmed" />
                {{ item.label }}
                <UIcon
                  name="i-lucide-check"
                  class="ms-auto size-3 shrink-0"
                  :class="choice.value === key ? 'text-primary' : 'opacity-0'"
                />
              </button>
            </li>
          </ul>
        </template>
      </UPopover>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      <UPopover v-for="group in groups" :key="group.name">
        <UButton
          size="xs"
          :color="selected(group.name).length ? 'primary' : 'neutral'"
          :variant="selected(group.name).length ? 'subtle' : 'outline'"
          :icon="group.icon"
          :label="summary(group.name, group.label)"
          trailing-icon="i-lucide-chevron-down"
          class="max-w-56"
        />

        <template #content>
          <div class="w-64 p-1">
            <ul class="max-h-72 overflow-y-auto">
              <li v-for="row in group.values" :key="row.value">
                <button
                  type="button"
                  class="relative w-full flex items-center gap-2 overflow-hidden rounded px-1.5 py-1 text-left text-xs transition-colors cursor-pointer"
                  :class="selected(group.name).includes(row.value)
                    ? 'text-highlighted'
                    : 'text-toned hover:bg-elevated/40'"
                  :aria-pressed="selected(group.name).includes(row.value)"
                  @click="toggle(group.name, row.value)"
                >
                  <!-- The bar is the comparison; it sits behind the text so the
                     row stays one line and reads as a label, not a chart.

                     Layered by source order, not by `-z-10`: inside a popover
                     that sent the bar behind the panel, leaving it visible
                     only while the open transition lasted. -->
                  <span
                    class="absolute inset-y-0 start-0 rounded"
                    :class="selected(group.name).includes(row.value) ? 'bg-primary/25' : 'bg-elevated/60'"
                    :style="{ width: `${Math.max(row.share * 100, 1.5)}%` }"
                  />

                  <UIcon
                    v-if="selected(group.name).includes(row.value)"
                    name="i-lucide-check"
                    class="relative size-3 shrink-0 text-primary"
                  />

                  <span class="relative min-w-0 flex-1 truncate font-mono">{{ row.value }}</span>

                  <span class="relative shrink-0 tabular-nums text-dimmed">{{ formatShare(row.share) }}</span>
                  <span class="relative w-8 shrink-0 text-end tabular-nums text-muted">{{ row.count }}</span>
                </button>
              </li>

              <!-- Said out loud rather than left to a scrollbar that stops: a
                 list silently cut reads as the whole set. -->
              <li v-if="group.more" class="border-t border-default mt-1 pt-1">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  block
                  label="Show more"
                  @click="emit('expand')"
                />
              </li>
            </ul>
          </div>
        </template>
      </UPopover>

      <UButton
        v-if="activeCount"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        :label="`Clear ${activeCount}`"
        @click="model = {}"
      />

      <!-- Pushed to the far end: it orders the list rather than narrowing it,
         and sitting among the filters made it read as another one. -->
      <UPopover class="ms-auto">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-down-wide-narrow"
          :label="sorts[sort]"
          trailing-icon="i-lucide-chevron-down"
        />

        <template #content>
          <ul class="w-40 p-1">
            <li v-for="(label, key) in sorts" :key="key">
              <button
                type="button"
                class="w-full flex items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors cursor-pointer"
                :class="sort === key ? 'text-highlighted bg-elevated/60' : 'text-toned hover:bg-elevated/40'"
                :aria-pressed="sort === key"
                @click="sort = key"
              >
                <UIcon
                  name="i-lucide-check"
                  class="size-3 shrink-0"
                  :class="sort === key ? 'text-primary' : 'opacity-0'"
                />
                {{ label }}
              </button>
            </li>
          </ul>
        </template>
      </UPopover>
    </div>
  </div>
</template>
