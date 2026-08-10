import { defineEventHandler } from '#imports'
import { monitorConfig, requireDashboardAccess, useMonitorStore } from '../context'

/**
 * The collector's own state.
 *
 * A monitoring tool that cannot report on itself asks to be trusted on faith.
 * An empty issue list means one thing when collection is healthy and something
 * else entirely when the database has been refusing writes for an hour — and
 * from the dashboard the two look identical.
 *
 * Behind the session check like every other dashboard route: the byte counts,
 * the storage path and the retention settings all describe the deployment, and
 * an unauthenticated endpoint that confirms `nuxt-monitor` is installed and how
 * much it is holding is a reconnaissance gift for no gain.
 */
export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const store = await useMonitorStore()
  const config = monitorConfig()

  return {
    ...store.health(),
    release: config.release || undefined,
    // Where to look when the reason is a filesystem one.
    storageDir: config.storageDir,
  }
})
