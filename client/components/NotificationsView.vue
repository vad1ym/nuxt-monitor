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

/**
 * A map rather than a ternary, which is what this was until Slack made it wrong.
 * The fallback covers the webhook and whatever is added next: an unfamiliar type
 * showing a generic icon is fine, a blank space where an icon belongs is not.
 */
const CHANNEL_ICON: Record<string, string> = {
  telegram: 'i-lucide-send',
  slack: 'i-lucide-message-square',
  webhook: 'i-lucide-webhook',
}

const data = ref<NotificationSettings | null>(null)
const loading = ref(true)
const error = ref('')
const testing = ref(false)
const testResult = ref<{ ok: boolean, message: string } | null>(null)

const channels = computed(() => data.value?.channels ?? [])
const groups = computed(() => data.value?.groups ?? [])

/** Groups that asked to be alerted on — a trigger like any other. */
const watched = computed(() => groups.value.filter(group => group.notify).map(group => group.name))

/** Declared, wanted, and unable to send — the state worth naming outright. */
const broken = computed(() => channels.value.filter(entry => entry.enabled && !entry.usable))
const deliveries = computed(() => data.value?.deliveries ?? [])

/**
 * The rules, as one sentence.
 *
 * This used to be two panels — a checklist of triggers and a table of
 * thresholds — and between them they took up half the screen to restate the
 * config file. `newIssue  true` tells a reader nothing they cannot read in
 * `nuxt.config`, and a screen whose largest element is a mirror of a file is a
 * screen that buries the one thing only it knows: what was actually sent.
 *
 * What survives is the part that answers the question people bring here, which
 * is never "what are the triggers" but "why did nobody tell me". Two of these
 * facts explain silence — the cooldown and the quiet hours — and the rest name
 * what would have had to happen. One line, above the log it explains.
 */
const rules = computed(() => {
  const configured = data.value?.triggers ?? {}
  const thresholds = configured.thresholds ?? [10, 100, 1_000]
  const causes: string[] = []

  if (configured.newIssue !== false) {
    causes.push('a new issue')
  }

  if (configured.regression !== false) {
    causes.push('a regression')
  }

  if (thresholds.length) {
    causes.push(`${thresholds.join('/')} occurrences`)
  }

  if (watched.value.length) {
    // Last, and with its own separator: this one is itself a list, so joining
    // the whole sentence with commas ran the group names together with the
    // triggers — "10/100/1000 occurrences, anything in third-party, payments"
    // reads as four causes rather than three.
    causes.push(`anything in ${watched.value.join(' or ')}`)
  }

  return causes
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

/** What stops one being sent, which is the half that explains a quiet night. */
const limits = computed(() => {
  const out: string[] = []
  const cooldown = data.value?.cooldownMinutes

  if (cooldown) {
    out.push(`at most one per issue every ${cooldown} min`)
  }

  if (quiet.value) {
    out.push(`silent ${quiet.value}`)
  }

  return out
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
  'watched': 'Watched',
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
        Add a Slack channel, a Telegram bot or a webhook under
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
              :name="CHANNEL_ICON[channel.type] ?? 'i-lucide-webhook'"
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

      <!-- What the application is divided into, and which parts asked to be
           heard about. On this screen rather than a section of its own: both
           answer "what are we watching and what comes of it", and splitting
           them would split the answer. -->
      <section v-if="groups.length" class="rounded-lg border border-default p-3">
        <h2 class="mb-2.5 text-xs font-medium uppercase tracking-wide text-dimmed">
          Groups
        </h2>

        <div class="space-y-1.5">
          <div
            v-for="group in groups"
            :key="group.name"
            class="flex items-start gap-3 rounded bg-elevated/40 px-2.5 py-2 text-sm"
          >
            <UIcon
              :name="group.notify ? 'i-lucide-bell' : 'i-lucide-tag'"
              class="mt-0.5 size-4 shrink-0"
              :class="group.notify ? 'text-primary' : 'text-dimmed'"
            />

            <div class="min-w-0 flex-1">
              <p class="text-toned">
                {{ group.name }}
              </p>
              <p class="truncate font-mono text-xs text-dimmed">
                {{ [...group.routes, ...group.messages].join('  ') }}
              </p>
            </div>

            <UBadge
              v-if="group.notify"
              size="sm"
              color="primary"
              variant="subtle"
              label="Alerts"
              title="Errors in this group raise an alert whenever they happen"
            />
          </div>
        </div>

        <p class="mt-2.5 text-xs text-dimmed">
          Configured under <code class="font-mono">monitor.groups</code>. A group with alerts on is
          still subject to the cooldown and the quiet hours.
        </p>
      </section>

      <section>
        <div class="mb-2 flex items-baseline justify-between gap-3">
          <h2 class="text-xs font-medium uppercase tracking-wide text-dimmed">
            Delivery log
          </h2>
          <span v-if="failures" class="text-xs text-error">
            {{ failures }} of the last {{ deliveries.length }} failed
          </span>
        </div>

        <!-- The rules, immediately above the log they explain. People come to
             this screen asking why nobody told them, and the answer is either
             "nothing qualified" or "something silenced it" — one line each,
             rather than the two panels of restated config that used to sit
             here and push the log itself below the fold. -->
        <p v-if="rules.length || limits.length" class="mb-2 text-xs text-dimmed">
          <template v-if="rules.length">
            Alerts on {{ rules.join(', ') }}.
          </template>
          <template v-else>
            Nothing raises an alert.
          </template>
          <template v-if="limits.length">
            {{ limits.join('; ') }}.
          </template>
        </p>

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
