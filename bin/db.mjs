/**
 * The CLI's own way into the database.
 *
 * The runtime ships as TypeScript — the consuming app compiles it, which is
 * what gives that app sourcemaps into our code — so a plain Node process
 * started by `npx` cannot import any of it. The commands here therefore speak
 * to db0 directly.
 *
 * That duplication is deliberate and bounded: this file knows how to *open* a
 * database and nothing about what the rows mean. Anything that interprets them
 * belongs in the runtime, where it is tested.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'

/** Mirrors `storageDir` in the module options. */
const DEFAULT_DIR = '.monitor'

/**
 * Opens the database a running app would be writing to.
 *
 * Read-write, because `purge` has to delete. Opening the same file a live
 * server holds is safe — it is WAL — and the commands here are short.
 */
export async function open(options = {}) {
  const url = options.url ?? process.env.NUXT_MONITOR_DATABASE_URL

  if (url) {
    return openExternal(url)
  }

  const dir = resolveDir(options.dir)
  const file = join(dir, 'monitor.db')

  if (!existsSync(file)) {
    throw new Error(
      `No database at ${file}. Point --dir at your \`storageDir\`, or set `
      + 'NUXT_MONITOR_DATABASE_URL for an external database.',
    )
  }

  const connector = nodeSqlite({ path: file })

  return { db: createDatabase(connector), dialect: 'sqlite', label: file, close: () => connector.dispose?.() }
}

function resolveDir(given) {
  const dir = given ?? process.env.NUXT_MONITOR_STORAGE_DIR ?? DEFAULT_DIR

  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir)
}

/**
 * Postgres and MySQL, loaded only when a URL asks for one.
 *
 * The drivers are peer-ish: `pg` and `mysql2` are not dependencies of this
 * package, so importing them eagerly would break `hash-password` on an install
 * that has neither.
 */
async function openExternal(url) {
  const scheme = url.split(':')[0]

  if (scheme === 'postgresql' || scheme === 'postgres') {
    const { default: postgresql } = await import('db0/connectors/postgresql')
    const connector = postgresql({ url })

    return { db: createDatabase(connector), dialect: 'postgresql', label: redact(url), close: () => connector.dispose?.() }
  }

  if (scheme === 'mysql' || scheme === 'mariadb') {
    const { default: mysql } = await import('db0/connectors/mysql2')
    const connector = mysql({ uri: url })

    return { db: createDatabase(connector), dialect: 'mysql', label: redact(url), close: () => connector.dispose?.() }
  }

  throw new Error(`Unsupported database URL scheme: ${scheme}`)
}

/** Never print a password back at somebody, however they got it in. */
function redact(url) {
  return url.replace(/\/\/[^@]*@/, '//***@')
}

/**
 * Rewrites backtick quoting for engines that do not use it.
 *
 * The same rule the runtime applies, for the same reason: `release` is
 * reserved in MySQL, and the queries are written once with backticks.
 */
export function quote(sql, dialect) {
  return dialect === 'mysql' ? sql : sql.replace(/`/g, '"')
}

/**
 * Column lists, kept in step with `lib/runtime/server/export.ts`.
 *
 * Duplicated because that file is TypeScript the consuming app compiles, and
 * this one runs under bare Node from `npx`. The pair is covered by a test that
 * diffs them, so the two cannot drift apart quietly — which is the only way
 * duplication like this is acceptable.
 */
export const EXPORT_COLUMNS = {
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
    'kind',
    'request_id',
    'user_id',
  ],
}

const TIME_COLUMN = { issues: 'last_seen', events: 'ts' }
const PAGE = 500

/** Yields the export a chunk at a time. Mirrors the runtime's `exportRows`. */
export async function* rows(db, dialect, options) {
  const { table, format, since } = options
  const columns = EXPORT_COLUMNS[table]
  const time = TIME_COLUMN[table]

  const selection = columns.map(column => column === 'release' ? '`release`' : column).join(', ')
  const where = since === undefined ? '' : `WHERE ${time} >= ?`
  const params = since === undefined ? [] : [since]

  yield format === 'csv' ? `${columns.join(',')}\n` : '[\n'

  let offset = 0
  let written = 0

  for (;;) {
    const page = await db
      .prepare(quote(
        `SELECT ${selection} FROM ${table} ${where} ORDER BY ${time} ASC LIMIT ? OFFSET ?`,
        dialect,
      ))
      .all(...params, PAGE, offset)

    if (page.length === 0) {
      break
    }

    for (const row of page) {
      yield format === 'csv'
        ? `${columns.map(column => csvCell(row[column])).join(',')}\n`
        : `${written === 0 ? '  ' : ',\n  '}${JSON.stringify(jsonRow(columns, row))}`

      written++
    }

    offset += page.length

    if (page.length < PAGE) {
      break
    }
  }

  if (format === 'json') {
    yield '\n]\n'
  }
}

function jsonRow(columns, row) {
  const out = {}

  for (const column of columns) {
    const value = row[column]

    if (value === null || value === undefined) {
      continue
    }

    if (column === 'context' || column === 'breadcrumbs' || column === 'tags') {
      try {
        out[column] = typeof value === 'string' ? JSON.parse(value) : value
      }
      catch {
        out[column] = value
      }
      continue
    }

    out[column] = value
  }

  return out
}

/**
 * One CSV cell.
 *
 * The leading-character guard matters: a cell starting `=`, `+`, `-` or `@` is
 * a formula to Excel and Sheets, and error messages are attacker-influenced
 * text. Handing somebody a spreadsheet that executes on open is a poor way to
 * repay them for using a security tool.
 */
export function csvCell(value) {
  if (value === null || value === undefined) {
    return ''
  }

  const text = String(value)
  const risky = /^[=+\-@\t\r]/.test(text)
  const escaped = (risky ? `'${text}` : text).replace(/"/g, '""')

  return /[",\n\r]/.test(escaped) || risky ? `"${escaped}"` : escaped
}
