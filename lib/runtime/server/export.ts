import type { Database } from 'db0'

/**
 * Getting the data back out.
 *
 * The argument for a local-first tool is that the data is yours; that argument
 * is only as good as the way out. A database somebody has to learn the schema
 * of before they can read it is a lock-in with extra steps, so this produces
 * two shapes: JSON for something that will be processed, CSV for something that
 * will be opened in a spreadsheet by a person.
 *
 * Streamed in pages rather than assembled in memory. An export is the one
 * operation that deliberately touches every row, and building a 200 MB string
 * to hand back would make "get my data out" the thing that finally exhausts the
 * heap of the application being monitored.
 */

export type ExportFormat = 'json' | 'csv'

/** What can be exported. Each is one table, flattened. */
export type ExportTable = 'issues' | 'events'

export interface ExportOptions {
  table: ExportTable
  format: ExportFormat
  /** Only rows at or after this epoch ms. */
  since?: number
  /** Hard ceiling on rows, so an accidental export of everything is bounded. */
  limit?: number
}

/** Rows read per query. Large enough to be few round trips, small enough to hold. */
const PAGE = 500

/**
 * The columns each table exports, in order.
 *
 * Written out rather than taken from `SELECT *` so that the output is stable:
 * a column added to the schema later must not silently reorder somebody's CSV
 * or change the shape their script parses. New columns go on the end, on
 * purpose.
 */
const COLUMNS: Record<ExportTable, string[]> = {
  issues: [
    'fingerprint',
    'type',
    'message',
    'side',
    'count',
    'first_seen',
    'last_seen',
    'resolved',
    'ignored',
    'culprit',
    'route',
    'method',
    'status',
    'manual',
    'level',
    'group_name',
    // On the end, as the note above requires: appended so an existing script
    // reading this CSV by position keeps working.
    'resolved_at',
    'regressed_at',
    'kind',
  ],
  events: [
    'id',
    'fingerprint',
    'ts',
    'message',
    'stack',
    'context',
    'breadcrumbs',
    'tags',
    'session',
    'browser',
    'browser_version',
    'os',
    'os_version',
    'device_type',
    'release',
    'route',
    'manual',
    'level',
    'group_name',
  ],
}

/**
 * The CSV header for a table.
 *
 * Exported so an empty export is still a well-formed file: a CSV with a header
 * and no rows says "nothing matched", where an empty file says nothing at all
 * and breaks whatever was going to read it.
 */
export function csvHeader(table: ExportTable): string {
  return `${COLUMNS[table].join(',')}\n`
}

/** The timestamp column each table is filtered and ordered by. */
const TIME_COLUMN: Record<ExportTable, string> = {
  issues: 'last_seen',
  events: 'ts',
}

/**
 * Yields the export a chunk at a time.
 *
 * An async generator rather than a callback so the caller decides what a chunk
 * is for — an HTTP response body, a file on disk, a pipe — without this file
 * knowing about any of them.
 */
export async function* exportRows(
  db: Database,
  options: ExportOptions,
): AsyncGenerator<string> {
  const { table, format } = options
  const columns = COLUMNS[table]
  const time = TIME_COLUMN[table]

  // `release` is reserved in MySQL and quoted with backticks, which the
  // connection layer rewrites per dialect.
  const selection = columns.map(column => column === 'release' ? '`release`' : column).join(', ')

  const where = options.since === undefined ? '' : `WHERE ${time} >= ?`
  const params = options.since === undefined ? [] : [options.since]

  yield format === 'csv' ? csvHeader(table) : '[\n'

  let offset = 0
  let written = 0
  const ceiling = options.limit ?? Number.POSITIVE_INFINITY

  while (written < ceiling) {
    const take = Math.min(PAGE, ceiling - written)

    // Ordered oldest-first and paged by offset. Offset paging degrades on very
    // large tables, but the alternative — a keyset cursor — needs a unique
    // ordering column, and `issues` is keyed by a fingerprint whose order says
    // nothing. Bounded by `limit`, which is what actually keeps this finite.
    const rows = await db
      .prepare(`SELECT ${selection} FROM ${table} ${where} ORDER BY ${time} ASC LIMIT ? OFFSET ?`)
      .all(...params, take, offset) as Record<string, unknown>[]

    if (rows.length === 0) {
      break
    }

    for (const row of rows) {
      yield format === 'csv'
        ? `${csvRow(columns, row)}\n`
        // Comma before every element but the first, so the array is valid JSON
        // without holding the whole thing to join it.
        : `${written === 0 ? '  ' : ',\n  '}${JSON.stringify(jsonRow(columns, row))}`

      written++
    }

    offset += rows.length

    if (rows.length < take) {
      break
    }
  }

  if (format === 'json') {
    yield '\n]\n'
  }
}

/**
 * A row as JSON.
 *
 * The columns holding JSON — context, breadcrumbs, tags — are parsed back into
 * structure rather than passed through as strings. An export whose fields are
 * strings containing JSON forces every consumer to parse twice, and the second
 * parse is the one they forget.
 */
function jsonRow(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const column of columns) {
    const value = row[column]

    if (value === null || value === undefined) {
      continue
    }

    out[column] = column === 'context' || column === 'breadcrumbs' || column === 'tags'
      ? parse(value)
      : value
  }

  return out
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value)
  }
  catch {
    // A malformed blob is still worth exporting as the text it is: dropping it
    // would lose data that the whole point of this is to hand over.
    return value
  }
}

function csvRow(columns: string[], row: Record<string, unknown>): string {
  return columns.map(column => csvCell(row[column])).join(',')
}

/**
 * One CSV cell, quoted the way spreadsheets expect.
 *
 * The leading-character guard is not decoration. A cell beginning `=`, `+`, `-`
 * or `@` is interpreted as a formula by Excel and Sheets, and error messages
 * are attacker-influenced text — this is the export of a security tool, and
 * handing somebody a spreadsheet that executes on open would be a poor way to
 * repay them for using it.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }

  const text = String(value)
  const risky = /^[=+\-@\t\r]/.test(text)
  const escaped = (risky ? `'${text}` : text).replace(/"/g, '""')

  return /[",\n\r]/.test(escaped) || risky ? `"${escaped}"` : escaped
}
