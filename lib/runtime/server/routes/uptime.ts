import { defineEventHandler, getQuery } from '#imports'
import { requireDashboardAccess, useMonitorStore } from '../context'

/**
 * Whether the application was up, day by day.
 *
 * Its own endpoint rather than a section of `/api/stats`: everything there is
 * bounded by the dashboard's shared window, and this deliberately is not. The
 * question "has this been reliable" is asked over months, and answering it for
 * the last six hours would be answering a different question.
 */
export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const days = Number(getQuery(event).days)

  return (await useMonitorStore()).uptime(
    // Bounded: the bar is drawn one cell per day, and a caller asking for ten
    // years would get a scan of the whole table for a chart nobody can read.
    Number.isFinite(days) ? Math.min(Math.max(days, 1), 365) : 90,
  )
})
