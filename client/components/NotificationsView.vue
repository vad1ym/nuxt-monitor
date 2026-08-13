<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { MonitorDelivery } from '../../lib/types'
import type { NotificationSettings } from '../api'
import { api } from '../api'
import { absoluteTime, relativeTime } from '../format'

/**
 * Who gets told, and what has actually been sent.
 *
 * Two things belong on this screen and nothing else does. The first is a test
 * button: a bot token and a chat id are copied by hand between three windows,
 * and the alternative way to discover a typo is the first real incident going
 * unreported. The second is the log — *including* the attempts that were
 * suppressed or failed, because the question people bring here is "why did
 * nobody tell me", and the answer to that is never among the successes.
 *
 * Configuration is read-only here on purpose. Channels carry secrets and live
 * in `nuxt.config`, so a deploy is reproducible and a token never sits in the
 * database. What the screen shows is what the running server resolved, which is
 * the thing worth checking against what you think you configured.
 */

const data = ref<NotificationSettings | null>(null)
const loading = ref(true)
const error = ref('')
const testing = ref(false)
const testResult = ref<{ ok: boolean, message: string } | null>(null)

const channels = computed(() => data.value?.channels ?? [])

/** Declared, wanted, and unable to send — the state worth naming outright. */
const broken = computed(() => channels.value.filter(entry => entry.enabled && !entry.usable))
const deliveries = computed(() => data.value?.deliveries ?? [])

/**
 * The triggers as sentences rather than a table of booleans.
 *
 * A row reading `newIssue  true` restates the config file. What a reader wants
 * is which events would reach them, so the ones that are off are shown struck
 * through rather than hidden — "regressions are not alerted" is information.
 */
const triggers = computed(() => {
  const configured = data.value?.triggers ?? {}
  const thresholds = configured.thresholds ?? [10, 100, 1_000]

  return [
    {
      key: 'new-issue',
      label: 'New issue',
      detail: 'A fingerprint seen for the first time',
      on: configured.newIssue !== false,
    },
    {
      key: 'regression',
      label: 'Regression',
      detail: 'An issue marked resolved happening again',
      on: configured.regression !== false,
    },
    {
      key: 'threshold',
      label: 'Growth',
      detail: thresholds.length
        ? `Crossing ${thresholds.join(', ')} occurrences`
        : 'Turned off',
      on: thresholds.length > 0,
    },
  ]
})

/** Quiet hours as one line, since that is how the config reads. */
const quiet = computed(() => {
  const window = data.value?.quietHours

  if (!window) {
    return ''
  }

  const days = window.days?.length && window.days.length < 7
    ? ` on ${window.days.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ')}`
    : ''

  return `${window.from}–${window.to}${window.timezone ? ` ${window.timezone}` : ''}${days}`
})

const STATUS: Record<MonitorDelivery['status'], { color: 'success' | 'error' | 'neutral', label: string }> = {
  sent: { color: 'success', label: 'Sent' },
  failed: { color: 'error', label: 'Failed' },
  // Not an error and not a success: the rule worked. Neutral rather than
  // warning, or a night of correct silence reads as a night of problems.
  suppressed: { color: 'neutral', label: 'Suppressed' },
}

const REASON: Record<MonitorDelivery['reason'], string> = {
  'new-issue': 'New issue',
  'regression': 'Regression',
  'threshold': 'Growth',
  'test': 'Test',
}

/**
 * How many of the recent attempts did not arrive.
 *
 * On the screen rather than left to be counted by eye: a channel that broke
 * three weeks ago looks exactly like a quiet month from the log alone.
 */
const failures = computed(() => deliveries.value.filter(entry => entry.status === 'failed').length)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''

  try {
    data.value = await api.notifications()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not load this section'
  }
  finally {
    loading.value = false
  }
}

async function sendTest(): Promise<void> {
  testing.value = true
  testResult.value = null

  try {
    const result = await api.testNotification()

    testResult.value = result.sent
      ? { ok: true, message: 'Sent. If it did not arrive, the token or the chat id is wrong.' }
      : {
          ok: false,
          // The per-channel reason when there is one: "failed" alone sends
          // somebody to the server logs for something already known here.
          message: result.reason
            ?? result.deliveries?.find(entry => entry.detail)?.detail
            ?? 'The channel did not accept the message.',
        }

    // The attempt is a log row like any other, and the log is what this screen
    // is for — so it has to show up without a manual reload.
    await load()
  }
  catch (caught) {
    testResult.value = {
      ok: false,
      message: caught instanceof Error ? caught.message : 'Could not send a test alert',
    }
  }
  finally {
    testing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-5">
    <header>
      <h1 class="text-lg font-semibold text-highlighted">
        Notifications
      </h1>
      <p class="text-sm text-dimmed">
        Channels are configured in <code class="font-mono text-toned">nuxt.config</code>, so tokens
        stay out of the database. This is what the running server resolved.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      icon="i-lucide-triangle-alert"
    />

    <div v-else-if="loading && !data" class="space-y-3">
      <USkeleton class="h-24 w-full" />
      <USkeleton class="h-32 w-full" />
    </div>

    <!-- Nothing configured. The one state where instructions beat an empty
         table, because there is nothing to look at and something to do.
         A channel declared but missing its credentials is NOT this state — it
         falls through to the list below, where it can be shown as broken. -->
    <div
      v-else-if="!data?.enabled && !channels.length"
      class="rounded-lg border border-dashed border-default py-14 text-center"
    >
      <UIcon name="i-lucide-bell-off" class="size-8 text-dimmed mx-auto" />
      <p class="mt-3 text-sm text-muted">
        No notification channel is configured, so nothing is alerted.
      </p>
      <p class="mx-auto mt-1 max-w-md text-xs text-dimmed">
        Add a Telegram bot or a webhook under
        <code class="font-mono">monitor.notifications.channels</code> and restart the server.
      </p>
    </div>

    <template v-else>
      <section class="rounded-lg border border-default p-3">
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Channels
          </h2>

          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-send"
            label="Send a test"
            :loading="testing"
            :disabled="!data.enabled"
            :class="data.enabled ? undefined : 'opacity-50'"
            :title="data.enabled ? undefined : 'No channel can send.'"
            @click="sendTest"
          />
        </div>

        <div class="space-y-1.5">
          <div
            v-for="channel in channels"
            :key="channel.name"
            class="flex items-center gap-3 rounded bg-elevated/40 px-2.5 py-2 text-sm"
          >
            <UIcon
              :name="channel.type === 'telegram' ? 'i-lucide-send' : 'i-lucide-webhook'"
              class="size-4 shrink-0 text-dimmed"
            />
            <span class="min-w-0 flex-1 truncate text-toned">{{ channel.name }}</span>
            <span class="font-mono text-xs text-dimmed">{{ channel.type }}</span>
            <UBadge
              v-if="!channel.enabled"
              size="sm"
              color="neutral"
              variant="subtle"
              label="Disabled"
            />
            <!-- Declared but unusable. Distinct from disabled, which is a
                 choice: this one is a configuration that will never send and
                 would otherwise look exactly like one that works. -->
            <UBadge
              v-else-if="!channel.usable"
              size="sm"
              color="error"
              variant="subtle"
              label="No credentials"
            />
          </div>
        </div>

        <UAlert
          v-if="broken.length"
          class="mt-3"
          color="error"
          variant="subtle"
          icon="i-lucide-key-round"
          :title="`${broken.length === 1 ? 'A channel has' : `${broken.length} channels have`} no token or URL, so ${broken.length === 1 ? 'it is' : 'they are'} skipped.`"
          description="Supply them through the environment when the server starts — see the Notifications guide. The server log names the variable for each."
        />

        <UAlert
          v-if="testResult"
          class="mt-3"
          :color="testResult.ok ? 'success' : 'error'"
          variant="subtle"
          :icon="testResult.ok ? 'i-lucide-check' : 'i-lucide-triangle-alert'"
          :title="testResult.message"
        />
      </section>

      <div class="grid gap-3 md:grid-cols-2">
        <section class="rounded-lg border border-default p-3">
          <h2 class="mb-2.5 text-xs font-medium uppercase tracking-wide text-dimmed">
            What raises an alert
          </h2>

          <div class="space-y-2">
            <div v-for="trigger in triggers" :key="trigger.key" class="flex items-start gap-2.5">
              <UIcon
                :name="trigger.on ? 'i-lucide-check' : 'i-lucide-minus'"
                class="mt-0.5 size-3.5 shrink-0"
                :class="trigger.on ? 'text-success' : 'text-dimmed'"
              />
              <div class="min-w-0">
                <p class="text-sm" :class="trigger.on ? 'text-toned' : 'text-dimmed line-through'">
                  {{ trigger.label }}
                </p>
                <p class="text-xs text-dimmed">
                  {{ trigger.detail }}
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- The three numbers that decide whether this feature is liveable.
             Worth stating outright: an hour of silence per issue is the
             difference between an alert and a pager nobody reads. -->
        <section class="rounded-lg border border-default p-3">
          <h2 class="mb-2.5 text-xs font-medium uppercase tracking-wide text-dimmed">
            What keeps it quiet
          </h2>

          <dl class="space-y-2 text-sm">
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-dimmed">
                Per-issue cooldown
              </dt>
              <dd class="tabular-nums text-toned">
                {{ data.cooldownMinutes }} min
              </dd>
            </div>
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-dimmed">
                Grouping window
              </dt>
              <dd class="tabular-nums text-toned">
                {{ data.groupWindowSeconds }}s
              </dd>
            </div>
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-dimmed">
                Quiet hours
              </dt>
              <dd class="text-end text-toned">
                {{ quiet || '—' }}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section>
        <div class="mb-2 flex items-baseline justify-between gap-3">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Delivery log
          </h2>
          <span v-if="failures" class="text-xs text-error">
            {{ failures }} of the last {{ deliveries.length }} failed
          </span>
        </div>

        <div v-if="!deliveries.length" class="rounded-lg border border-dashed border-default py-10 text-center">
          <p class="text-sm text-muted">
            Nothing sent yet.
          </p>
          <p class="mt-1 text-xs text-dimmed">
            Alerts appear here as they are raised — including the ones a rule silenced.
          </p>
        </div>

        <div v-else class="space-y-0.5">
          <div
            v-for="entry in deliveries"
            :key="entry.id"
            class="flex items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-elevated/40"
          >
            <UBadge
              size="sm"
              variant="subtle"
              :color="STATUS[entry.status].color"
              :label="STATUS[entry.status].label"
              class="shrink-0"
            />

            <span class="shrink-0 text-toned">{{ REASON[entry.reason] }}</span>

            <!-- Grouped messages are the normal case during an incident, and a
                 row that does not say so understates what happened. -->
            <span v-if="entry.alerts > 1" class="shrink-0 text-xs text-dimmed">
              ×{{ entry.alerts }}
            </span>

            <!-- What it was about, or — for a row that is not a send — why it
                 was not. The second is the column this screen exists for, so it
                 wins the space when both could be shown. -->
            <span
              v-if="entry.detail"
              class="min-w-0 flex-1 truncate text-xs"
              :class="entry.status === 'failed' ? 'text-error' : 'text-dimmed'"
              :title="entry.detail"
            >
              {{ entry.detail }}
            </span>

            <span
              v-else-if="entry.issue"
              class="min-w-0 flex-1 truncate text-xs text-dimmed"
              :title="`${entry.issue.type}: ${entry.issue.message}`"
            >
              <span class="font-mono text-muted">{{ entry.issue.type }}</span>
              {{ entry.issue.message }}
            </span>

            <span v-else class="min-w-0 flex-1" />

            <span class="shrink-0 font-mono text-xs text-dimmed">{{ entry.channel }}</span>

            <span
              class="w-20 shrink-0 text-end text-xs text-dimmed"
              :title="absoluteTime(entry.at)"
            >
              {{ relativeTime(entry.at) }}
            </span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
