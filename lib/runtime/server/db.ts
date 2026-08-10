import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import mysql from 'db0/connectors/mysql2'
import postgresql from 'db0/connectors/postgresql'
import type { Connector, Database } from 'db0'

/**
 * The database connection, behind one seam.
 *
 * Everything above this file speaks db0's `exec`/`prepare` and nothing else,
 * so swapping the connector swaps the engine. That is the whole reason db0 is
 * here rather than `node:sqlite` directly — the store used to hold a
 * `DatabaseSync` and call it synchronously, which made "use Postgres" a
 * rewrite rather than a setting.
 */

/** Which engine to talk to. SQLite unless asked otherwise. */
export type MonitorDialect = 'sqlite' | 'mysql' | 'postgresql'

export interface DatabaseOptions {
  /** Directory for the SQLite file. Ignored by the other connectors. */
  dir: string
  /**
   * Connection string for an external database.
   *
   * Absent means SQLite in `dir`, which is the default and the case the module
   * is designed around: no service to run, nothing to configure.
   */
  url?: string
}

export interface MonitorDatabase {
  db: Database
  dialect: MonitorDialect
  /**
   * The underlying driver handle, when there is a useful one.
   *
   * Only SQLite exposes anything worth reaching for — `PRAGMA page_count` and
   * friends, which is how the byte ceiling measures itself. Kept narrow and
   * optional on purpose: anything that needs this does not work on an external
   * database, and the type should say so rather than let it be assumed.
   */
  native?: unknown
  close: () => Promise<void>
}

/**
 * Opens the database described by `options`.
 *
 * Throws if it cannot be opened. The caller turns collection off in that case
 * rather than taking the application down with it — see `useMonitorStore`.
 */
export function openDatabase(options: DatabaseOptions): MonitorDatabase {
  if (options.url) {
    return openExternal(options.url)
  }

  // Created eagerly rather than left to the connector: it resolves paths
  // against its own defaults, and the storage directory is already an absolute
  // path decided at build time.
  mkdirSync(options.dir, { recursive: true })

  const connector = nodeSqlite({ path: join(options.dir, 'monitor.db') })
  const db = createDatabase(connector)

  return {
    db: quoting(db, 'sqlite'),
    dialect: 'sqlite',
    native: connector.getInstance?.(),
    close: async () => {
      await connector.dispose?.()
    },
  }
}

/**
 * Opens an external database from its connection string.
 *
 * The driver is imported only once a url asks for it, so an install that stays
 * on SQLite — the default, and the case the module is built around — never
 * needs `pg` or `mysql2` present at all. They are optional peers for exactly
 * that reason.
 *
 * An unknown scheme throws rather than falling back to SQLite: an application
 * that starts, serves a working dashboard, and writes its errors somewhere
 * other than where they were configured to go is the worst outcome available,
 * and it would be discovered during an incident.
 */
function openExternal(url: string): MonitorDatabase {
  const scheme = (url.split(':')[0] ?? '').toLowerCase()

  if (scheme === 'postgres' || scheme === 'postgresql') {
    return connect('postgresql', () => postgresql({ url }))
  }

  if (scheme === 'mysql' || scheme === 'mariadb') {
    return connect('mysql', () => mysql({ uri: url }))
  }

  throw new Error(
    `[monitor] unsupported database url scheme "${scheme}:". `
    + 'Use postgresql://, mysql://, or leave `monitor.databaseUrl` unset for SQLite.',
  )
}

function connect(dialect: MonitorDialect, make: () => Connector): MonitorDatabase {
  const connector = make()

  return {
    db: quoting(createDatabase(connector), dialect),
    dialect,
    close: async () => {
      await connector.dispose?.()
    },
  }
}

/**
 * Rewrites identifier quoting on the way to the driver.
 *
 * `release` is a reserved word in MySQL, so every query that names that column
 * has to quote it — and MySQL quotes identifiers with backticks while SQLite
 * and Postgres want double quotes. Doing it here rather than at each call site
 * means a query is written once, with backticks, and cannot reach a server in
 * the wrong dialect because somebody forgot to wrap it: there is one place
 * left that talks to the driver.
 */
function quoting(db: Database, dialect: MonitorDialect): Database {
  if (dialect === 'mysql') {
    return db
  }

  const translate = (sql: string): string => sql.replace(/`/g, '"')

  // A plain object with the two methods replaced, rather than a Proxy: a Proxy
  // forwards an assignment to `exec` through to the target and then reads it
  // back through the same trap, so anything that swaps the method out — the
  // resilience tests do exactly that — recurses until the stack gives out.
  const wrapped = Object.create(db) as Database

  wrapped.exec = sql => db.exec(translate(sql))
  wrapped.prepare = sql => db.prepare(translate(sql))

  return wrapped
}

/**
 * An "insert, or update what is already there" clause.
 *
 * MySQL spells this `ON DUPLICATE KEY UPDATE` and has no `excluded` pseudo-row;
 * it exposes the rejected values as `VALUES(col)` instead. Postgres takes the
 * standard form but resolves a bare column name against both the table and the
 * proposed row, so `count = count + 1` is rejected as ambiguous where SQLite
 * accepts it — hence the explicit table qualifier.
 *
 * `assignments` are written once, in SQLite's spelling, and translated here.
 */
export function upsertClause(
  dialect: MonitorDialect,
  table: string,
  conflict: string[],
  assignments: string[],
): string {
  if (dialect === 'mysql') {
    return `ON DUPLICATE KEY UPDATE ${assignments
      .map(a => a.replace(/excluded\.(\w+)/g, 'VALUES($1)'))
      .join(', ')}`
  }

  const qualified = dialect === 'postgresql'
    ? assignments.map(a => qualifyAssignment(a, table))
    : assignments

  return `ON CONFLICT(${conflict.join(', ')}) DO UPDATE SET ${qualified.join(', ')}`
}

/** Words in an assignment that are never column references. */
const KEYWORDS = new Set([
  'NULL',
  'TRUE',
  'FALSE',
  'AND',
  'OR',
  'NOT',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
])

/**
 * Qualifies the read side of `col = expr` with the table name.
 *
 * Only the right-hand side: the assignment target must stay bare, since
 * Postgres does not allow the table to be named there.
 */
function qualifyAssignment(assignment: string, table: string): string {
  const [target, ...rest] = assignment.split('=')
  const expression = rest.join('=')
  const name = target!.trim()

  // Every bare identifier that is not already qualified, not a function call
  // and not a keyword refers to the existing row.
  const resolved = expression.replace(
    /(?<![.\w])([a-z_]\w*)\s*(\(?)/gi,
    (match, word: string, call: string) =>
      call === '(' || KEYWORDS.has(word.toUpperCase()) || word.toLowerCase() === 'excluded'
        ? match
        : `${table}.${word}${match.slice(word.length)}`,
  )

  return `${name} =${resolved}`
}

/**
 * How many rows a write touched.
 *
 * Each driver reports this under its own name — SQLite `changes`, MySQL
 * `affectedRows`, Postgres `rowCount` — and the difference is not cosmetic:
 * the byte-ceiling loop stops when a delete frees nothing, so reading the
 * wrong key would have it spin against a database it believes it never
 * changed.
 */
export function changesOf(result: unknown): number {
  const row = result as { changes?: number, affectedRows?: number, rowCount?: number }

  return Number(row?.changes ?? row?.affectedRows ?? row?.rowCount ?? 0)
}
