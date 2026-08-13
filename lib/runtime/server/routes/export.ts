import { defineEventHandler, getQuery, setResponseHeader } from '#imports'
import type { ExportFormat, ExportTable } from '../export'
import { requireDashboardAccess, useMonitorStore } from '../context'

/**
 * Downloading the data.
 *
 * Behind the session check like every other dashboard route, and more
 * pointedly than most: this one hands over every stack trace and every
 * captured context in the database at once.
 *
 * Streamed rather than assembled. An export deliberately touches every row, so
 * building the whole body in memory would make "get my data out" the operation
 * that exhausts the heap of the application being monitored.
 */
export default defineEventHandler(async (event) => {
  requireDashboardAccess(event)

  const query = getQuery(event)
  const table: ExportTable = query.table === 'events' ? 'events' : 'issues'
  const format: ExportFormat = query.format === 'csv' ? 'csv' : 'json'

  const since = Number(query.since)
  const limit = Number(query.limit)

  const store = await useMonitorStore()

  // Pending events belong in an export as much as in a list: a download taken
  // right after an incident should contain the incident.
  await store.flush()

  setResponseHeader(event, 'content-type', format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/json; charset=utf-8')

  // A date in the name, because these accumulate in a downloads folder and
  // `issues.csv (3)` is not a filename anybody can act on later.
  const stamp = new Date().toISOString().slice(0, 10)

  setResponseHeader(
    event,
    'content-disposition',
    `attachment; filename="monitor-${table}-${stamp}.${format}"`,
  )

  const rows = store.exportRows({
    table,
    format,
    since: Number.isFinite(since) && since > 0 ? since : undefined,
    // Bounded by default. Someone clicking a button should not be able to
    // start an unbounded scan of a table with millions of rows by accident;
    // `limit=0` asks for everything deliberately.
    limit: Number.isFinite(limit) ? (limit > 0 ? limit : undefined) : 50_000,
  })

  return toStream(rows)
})

/**
 * An async generator as a web stream.
 *
 * h3 returns a `ReadableStream` as the body without buffering it, which is the
 * whole point — the generator produces a page at a time and the response is
 * written as it goes.
 */
function toStream(rows: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await rows.next()

        if (done) {
          controller.close()
          return
        }

        controller.enqueue(encoder.encode(value))
      }
      catch (error) {
        // The response has already begun, so there is no status left to
        // change: the download ends short. Erroring the stream is what tells
        // the client it is truncated rather than complete.
        controller.error(error)
      }
    },
  })
}
