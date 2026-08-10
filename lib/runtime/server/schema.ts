import type { Database } from 'db0'
import type { MonitorDialect } from './db'

/**
 * The database shape, and how an existing one is brought up to it.
 *
 * Separated from the store because schema evolution is its own concern: what
 * the tables are and how a database written by an older version of the module
 * catches up, with no reference to buffering, flushing or reads.
 *
 * Written per dialect rather than once, because the differences are not
 * cosmetic and each was measured against a real server rather than guessed:
 *
 * - MySQL cannot index a `TEXT` column without a prefix length, so every
 *   column that takes part in a key is a bounded `VARCHAR`.
 * - MySQL has no `CREATE INDEX IF NOT EXISTS`, so indexes are declared inside
 *   `CREATE TABLE` where re-running is harmless.
 * - Postgres spells an auto-incrementing key `GENERATED ... AS IDENTITY`, and
 *   `AUTOINCREMENT` is a syntax error rather than a no-op.
 */

/** Column types that differ by engine. */
interface Types {
  /** Auto-incrementing primary key for `events`. */
  id: string
  /** A short identifier that participates in a key. */
  key: (length: number) => string
  /** Free text with no length limit and no part in any key. */
  text: string
  int: string
}

const TYPES: Record<MonitorDialect, Types> = {
  sqlite: {
    id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    key: () => 'TEXT',
    text: 'TEXT',
    int: 'INTEGER',
  },
  postgresql: {
    id: 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
    key: length => `VARCHAR(${length})`,
    text: 'TEXT',
    // Timestamps are epoch milliseconds, which overflow a 32-bit INTEGER.
    int: 'BIGINT',
  },
  mysql: {
    id: 'BIGINT AUTO_INCREMENT PRIMARY KEY',
    key: length => `VARCHAR(${length})`,
    text: 'TEXT',
    int: 'BIGINT',
  },
}

/**
 * Index declarations.
 *
 * SQLite and Postgres both take `CREATE INDEX IF NOT EXISTS`, which is safe to
 * re-run. MySQL has no such form and errors on a duplicate, so there the same
 * indexes are declared inside the table instead.
 */
const INDEXES: [name: string, table: string, columns: string][] = [
  ['idx_events_fp_ts', 'events', 'fingerprint, ts DESC'],
  ['idx_issues_last', 'issues', 'last_seen DESC'],
  ['idx_stats_bucket', 'request_stats', 'bucket DESC'],
  // Facet queries filter on time first and group second, so the timestamp
  // leads.
  ['idx_events_ts', 'events', 'ts DESC'],
]

function tables(dialect: MonitorDialect): string[] {
  const t = TYPES[dialect]
  const inline = dialect === 'mysql'

  /** MySQL declares its indexes here; the others add them separately. */
  const indexesFor = (table: string): string => inline
    ? INDEXES.filter(([, on]) => on === table)
        .map(([name, , columns]) => `,\n  INDEX ${name} (${columns})`)
        .join('')
    : ''

  return [
    `CREATE TABLE IF NOT EXISTS issues (
  fingerprint ${t.key(64)} PRIMARY KEY,
  type        ${t.key(191)} NOT NULL,
  message     ${t.text} NOT NULL,
  side        ${t.key(16)} NOT NULL,
  count       ${t.int} NOT NULL DEFAULT 0,
  first_seen  ${t.int} NOT NULL,
  last_seen   ${t.int} NOT NULL,
  resolved    ${t.int} NOT NULL DEFAULT 0,
  culprit     ${t.text},
  route       ${t.text},
  method      ${t.key(16)},
  status      ${t.int}${indexesFor('issues')}
)`,

    // Facet columns are stored on the event rather than parsed out of the
    // context JSON on read: a breakdown groups over every event behind an
    // issue, and doing that through JSON would mean parsing hundreds of blobs
    // per query.
    `CREATE TABLE IF NOT EXISTS events (
  id          ${t.id},
  fingerprint ${t.key(64)} NOT NULL,
  ts          ${t.int} NOT NULL,
  stack       ${t.text},
  context     ${t.text},
  breadcrumbs ${t.text},
  tags        ${t.text},
  message     ${t.text},
  session     ${t.key(64)},
  browser     ${t.key(64)},
  browser_version ${t.key(32)},
  os          ${t.key(64)},
  os_version  ${t.key(32)},
  device_type ${t.key(32)},
  \`release\`   ${t.key(64)},
  route       ${t.text}${indexesFor('events')}
)`,

    // Counters only: how many requests of each shape, and how they ended. No
    // bodies, headers or addresses — this exists to give error counts a
    // denominator, not to record traffic.
    `CREATE TABLE IF NOT EXISTS request_stats (
  bucket  ${t.int} NOT NULL,
  route   ${t.key(191)} NOT NULL,
  method  ${t.key(16)} NOT NULL,
  class   ${t.key(16)} NOT NULL,
  count   ${t.int} NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, route, method, class)${indexesFor('request_stats')}
)`,
  ]
}

/**
 * Creates the schema and applies any columns added after it was first written.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an older table untouched, so columns
 * added later have to be applied separately — otherwise upgrading the module
 * would make an existing `.monitor` database fail on the first write.
 */
export async function migrate(db: Database, dialect: MonitorDialect = 'sqlite'): Promise<void> {
  for (const statement of tables(dialect)) {
    await db.exec(statement)
  }

  if (dialect !== 'mysql') {
    for (const [name, table, columns] of INDEXES) {
      await db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns})`)
    }
  }

  await addColumns(db, dialect, 'issues', [
    ['culprit', TYPES[dialect].text],
    ['route', TYPES[dialect].text],
    ['method', TYPES[dialect].key(16)],
    ['status', TYPES[dialect].int],
    // Distinct from `resolved`, which claims a fix. This one says "not mine" —
    // a browser extension, a bot, a page a crawler asks for. Without it the
    // only way to quiet noise is to mark it fixed, which makes the resolved
    // list a lie and eventually makes the open list unreadable.
    ['ignored', TYPES[dialect].int],
  ])

  // Facets, added after the first release. Existing rows keep NULL and show
  // up as "unknown" in a breakdown rather than breaking the query.
  await addColumns(db, dialect, 'events', [
    ['message', TYPES[dialect].text],
    ['session', TYPES[dialect].key(64)],
    ['browser', TYPES[dialect].key(64)],
    ['browser_version', TYPES[dialect].key(32)],
    ['os', TYPES[dialect].key(64)],
    ['os_version', TYPES[dialect].key(32)],
    ['device_type', TYPES[dialect].key(32)],
    ['release', TYPES[dialect].key(64)],
    ['route', TYPES[dialect].text],
  ])
}

/**
 * Columns already present on a table.
 *
 * `PRAGMA table_info` is SQLite-only, so the others read `information_schema` —
 * which is standard and, unlike a size query, readable by the owner of the
 * table on managed hosting.
 */
async function existingColumns(db: Database, dialect: MonitorDialect, table: string): Promise<Set<string>> {
  if (dialect === 'sqlite') {
    const rows = await db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]

    return new Set(rows.map(column => column.name))
  }

  const rows = await db
    .prepare('SELECT column_name FROM information_schema.columns WHERE table_name = ?')
    .all(table) as Record<string, unknown>[]

  // MySQL answers `COLUMN_NAME`, Postgres `column_name`.
  return new Set(rows.map(row => String(row.column_name ?? row.COLUMN_NAME)))
}

async function addColumns(
  db: Database,
  dialect: MonitorDialect,
  table: string,
  columns: [string, string][],
): Promise<void> {
  const existing = await existingColumns(db, dialect, table)

  for (const [name, type] of columns) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN \`${name}\` ${type}`)
    }
  }
}

/** Width of a counter bucket. One minute is fine for a day-scale chart. */
export const BUCKET_MS = 60_000
