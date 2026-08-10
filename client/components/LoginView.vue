<script setup lang="ts">
import { reactive, ref } from 'vue'
import { api } from '../api'

const emit = defineEmits<{ authenticated: [] }>()

const state = reactive({ username: 'admin', password: '' })
const error = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  if (busy.value) {
    return
  }

  busy.value = true
  error.value = ''

  try {
    await api.login(state.username, state.password)
    emit('authenticated')
  }
  catch (caught) {
    // The server deliberately does not say which half was wrong; repeat that
    // rather than inventing a more specific message.
    error.value = caught instanceof Error ? caught.message : 'Sign-in failed'
    state.password = ''
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-screen grid place-items-center p-6">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-radar" class="size-5 text-primary" />
          <h1 class="text-lg font-semibold">
            monitor
          </h1>
        </div>
        <p class="text-sm text-muted mt-1">
          Sign in to view collected errors.
        </p>
      </template>

      <UForm :state="state" class="space-y-4" @submit="submit">
        <UFormField label="Username" name="username">
          <UInput
            v-model="state.username"
            autocomplete="username"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password">
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="current-password"
            autofocus
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          icon="i-lucide-triangle-alert"
        />

        <UButton
          type="submit"
          block
          :loading="busy"
          label="Sign in"
        />
      </UForm>
    </UCard>
  </div>
</template>
