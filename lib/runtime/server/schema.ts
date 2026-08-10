import type { Database } from 'db0'

/**
 * The database shape, and how an existing one is brought up to it.
 *
 * Separated from the store because schema evolution is its own concern: what
 * the tables are and how a database written by an older version of the module
 * catches up, with no reference to buffering, flushing or reads.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  fingerprint TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  side        TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  -- Denormalised from the most recent event so the list can show where an
  -- error happened without loading every event behind it.
  culprit     TEXT,
  route       TEXT,
  method      TEXT,
  status      INTEGER
);

-- Facet columns are stored on the event rather than parsed out of the context
-- JSON on read: a breakdown groups over every event behind an issue, and doing
-- that through JSON would mean parsing hundreds of blobs per query.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  stack       TEXT,
  context     TEXT,
  breadcrumbs TEXT,
  tags        TEXT,
  -- The message as this occurrence reported it. Without it every occurrence
  -- had to borrow the issue's message, which is the *most recent* one — so
  -- "User 12345 not found" showed the newest id on all 250 rows.
  message     TEXT,
  session     TEXT,
  browser     TEXT,
  browser_version TEXT,
  os          TEXT,
  os_version  TEXT,
  device_type TEXT,
  release     TEXT,
  route       TEXT
);

-- Counters only: how many requests of each shape, and how they ended. No
-- bodies, headers or addresses — this exists to give error counts a
-- denominator, not to record traffic.
CREATE TABLE IF NOT EXISTS request_stats (
  bucket  INTEGER NOT NULL,
  route   TEXT NOT NULL,
  method  TEXT NOT NULL,
  class   TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, route, method, class)
);

CREATE INDEX IF NOT EXISTS idx_events_fp_ts   ON events(fingerprint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_issues_last    ON issues(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_stats_bucket   ON request_stats(bucket DESC);
-- Facet queries filter on time first and group second, so the timestamp leads.
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts DESC);
`

/** Width of a counter bucket. One minute is fine for a day-scale chart. */

/**
 * Creates the schema and applies any columns added after it was first written.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an older table untouched, so columns
 * added later have to be applied separately — otherwise upgrading the module
 * would make an existing `.monitor` database fail on the first write.
 */
export async function migrate(db: Database): Promise<void> {
  // One statement at a time: `exec` on an external driver does not accept a
  // multi-statement string, and SQLite is indifferent either way.
  for (const statement of SCHEMA.split(';')) {
    if (statement.trim()) {
      await db.exec(statement)
    }
  }

  await addColumns(db, 'issues', [
    ['culprit', 'TEXT'],
    ['route', 'TEXT'],
    ['method', 'TEXT'],
    ['status', 'INTEGER'],
  ])

  // Facets, added after the first release. Existing rows keep NULL and show
  // up as "unknown" in a breakdown rather than breaking the query.
  await addColumns(db, 'events', [
    ['message', 'TEXT'],
    ['session', 'TEXT'],
    ['browser', 'TEXT'],
    ['browser_version', 'TEXT'],
    ['os', 'TEXT'],
    ['os_version', 'TEXT'],
    ['device_type', 'TEXT'],
    ['release', 'TEXT'],
    ['route', 'TEXT'],
  ])
}

async function addColumns(db: Database, table: string, columns: [string, string][]): Promise<void> {
  // The table name is one of two literals from the call sites above, never
  // user input.
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  const existing = new Set(rows.map(column => column.name))

  for (const [name, type] of columns) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
    }
  }
}

/** Width of a counter bucket. One minute is fine for a day-scale chart. */
export const BUCKET_MS = 60_000
