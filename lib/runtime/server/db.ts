import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import type { Database } from 'db0'

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
    db,
    dialect: 'sqlite',
    native: connector.getInstance?.(),
    close: async () => {
      await connector.dispose?.()
    },
  }
}

/**
 * Not yet implemented, and failing loudly rather than quietly falling back.
 *
 * A silent fallback to SQLite would be the worst outcome available: the
 * application would start, the dashboard would work, and the errors would be
 * going somewhere other than where they were configured to go — discovered
 * during the first incident, which is the moment they are needed.
 */
function openExternal(url: string): never {
  const scheme = url.split(':')[0] ?? url

  throw new Error(
    `[monitor] external databases are not supported yet (got "${scheme}:"). `
    + 'Leave `monitor.database.url` unset to use SQLite.',
  )
}
