import { defineEventHandler, getQuery } from '#imports'
import { requireDashboardAccess, useMonitorStore } from '../context'

/** Windows the overview can be asked for, in hours. */
const WINDOWS = new Set([1, 6, 24, 24 * 7])

export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const hours = Number(getQuery(event).hours)
  const window = WINDOWS.has(hours) ? hours : 24

  return (await useMonitorStore()).overview(window * 60 * 60 * 1_000)
})
