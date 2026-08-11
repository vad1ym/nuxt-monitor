import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, pick, upsertClause } from './db'

/**
 * The connection seam.
 *
 * The store above it now speaks only db0's `exec`/`prepare`, and these cover
 * the two things that has to keep providing: a SQLite file where the module
 * says it will be, and the transaction and upsert behaviour the write path is
 * built on — which arrive as raw SQL rather than through an API, and so are
 * worth pinning rather than assuming.
 */
describe('openDatabase', () => {
  let dir: string

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function open() {
    dir = mkdtempSync(join(tmpdir(), 'monitor-db-'))
    return openDatabase({ dir: join(dir, 'nested') })
  }

  it('creates the file under the directory it was given', async () => {
    const { close } = open()

    // Nested, because `storageDir` may name a directory that does not exist.
    expect(existsSync(join(dir, 'nested', 'monitor.db'))).toBe(true)
    await close()
  })

  it('reports the dialect it opened', () => {
    expect(open().dialect).toBe('sqlite')
  })

  /** `bytes()` reads PRAGMAs through this, and nothing else can supply them. */
  it('exposes the native handle for SQLite', () => {
    expect(open().native).toBeDefined()
  })

  it('commits and rolls back through raw SQL', async () => {
    const { db, close } = open()

    await db.exec('CREATE TABLE t (fp TEXT PRIMARY KEY, n INTEGER NOT NULL)')

    await db.exec('BEGIN')
    await db.prepare('INSERT INTO t (fp, n) VALUES (?, ?)').run('kept', 1)
    await db.exec('COMMIT')

    // A rollback has to actually undo: the flush path requeues its batch on
    // the assumption that a failed transaction wrote nothing.
    await db.exec('BEGIN')
    await db.prepare('INSERT INTO t (fp, n) VALUES (?, ?)').run('undone', 1)
    await db.exec('ROLLBACK')

    expect(await db.prepare('SELECT n FROM t WHERE fp = ?').get('kept')).toBeDefined()
    expect(await db.prepare('SELECT n FROM t WHERE fp = ?').get('undone')).toBeUndefined()

    await close()
  })

  /** Both the issue upsert and the counter upsert depend on this. */
  it('supports ON CONFLICT upserts', async () => {
    const { db, close } = open()

    await db.exec('CREATE TABLE t (fp TEXT PRIMARY KEY, n INTEGER NOT NULL)')

    const upsert = db.prepare(
      'INSERT INTO t (fp, n) VALUES (?, 1) ON CONFLICT(fp) DO UPDATE SET n = n + 1',
    )

    await upsert.run('same')
    await upsert.run('same')

    const row = await db.prepare('SELECT n FROM t WHERE fp = ?').get('same') as { n: number }

    expect(Number(row.n)).toBe(2)
    await close()
  })

  /**
   * A silent fallback to SQLite would be the worst outcome available: the app
   * would start, the dashboard would work, and the errors would be going
   * somewhere other than where they were configured to go.
   */
  it('refuses an unknown url scheme rather than quietly using SQLite', () => {
    expect(() => openDatabase({ dir: tmpdir(), url: 'mongodb://localhost/x' }))
      .toThrow(/unsupported database url scheme/)
  })

  it('selects a dialect from the url scheme', () => {
    // Connecting is lazy, so this asserts the routing without a live server.
    expect(openDatabase({ dir: tmpdir(), url: 'postgresql://u@h/db' }).dialect).toBe('postgresql')
    expect(openDatabase({ dir: tmpdir(), url: 'postgres://u@h/db' }).dialect).toBe('postgresql')
    expect(openDatabase({ dir: tmpdir(), url: 'mysql://u@h/db' }).dialect).toBe('mysql')
    expect(openDatabase({ dir: tmpdir(), url: 'mariadb://u@h/db' }).dialect).toBe('mysql')
  })
})

/**
 * The SQL each engine actually wants.
 *
 * These strings never run in the unit suite — the external tests that would
 * catch a bad one need a live MySQL and Postgres — so the spelling is asserted
 * here instead. A `MAX(a, b)` shipped to Postgres is a runtime error, and a
 * double-qualified `issues.issues.last_seen` is another.
 */
describe('dialect spelling', () => {
  it('uses the scalar two-argument form each engine provides', () => {
    expect(pick('sqlite', 'max', 'a', 'b')).toBe('MAX(a, b)')
    expect(pick('mysql', 'min', 'a', 'b')).toBe('MIN(a, b)')
    // Postgres reserves MAX/MIN for aggregates.
    expect(pick('postgresql', 'max', 'a', 'b')).toBe('GREATEST(a, b)')
    expect(pick('postgresql', 'min', 'a', 'b')).toBe('LEAST(a, b)')
  })

  it('qualifies a column inside a function call exactly once', () => {
    const clause = upsertClause('postgresql', 'issues', ['fingerprint'], [
      `last_seen = ${pick('postgresql', 'max', 'last_seen', 'excluded.last_seen')}`,
    ])

    expect(clause).toContain('GREATEST(issues.last_seen, excluded.last_seen)')
    expect(clause).not.toContain('issues.issues')
  })

  it('rewrites the proposed row into the spelling MySQL provides', () => {
    const assignments = [`last_seen = ${pick('mysql', 'max', 'last_seen', 'excluded.last_seen')}`]

    // MySQL has no `excluded` pseudo-row.
    expect(upsertClause('mysql', 'issues', ['fingerprint'], assignments))
      .toContain('MAX(last_seen, VALUES(last_seen))')
  })
})
