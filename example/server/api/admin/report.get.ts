/**
 * A slow report that fails deep inside an async call.
 *
 * The stack is the point. By the time this rejects, the frames that describe
 * the *request* are gone — what is left points into the query helper, several
 * awaits away from the handler. Grouping and the "where" line both have to
 * survive that, and an example without a single async rejection would never
 * show whether they do.
 */
export default defineEventHandler(async () => {
  const rows = await queryDailyTotals(new Date())

  return { rows }
})

async function queryDailyTotals(day: Date): Promise<unknown[]> {
  await new Promise(resolve => setTimeout(resolve, 5))

  return summarise(day)
}

async function summarise(day: Date): Promise<unknown[]> {
  await new Promise(resolve => setTimeout(resolve, 5))

  throw new Error(
    `Report for ${day.toISOString().slice(0, 10)} timed out after 30000ms waiting on the analytics store`,
  )
}
