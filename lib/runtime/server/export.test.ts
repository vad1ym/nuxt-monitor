import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MonitorEvent } from '../../types'
import { csvCell, csvHeader } from './export'
import { MonitorStore } from './store'

let dir: string
let store: MonitorStore

function event(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    side: 'server',
    type: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at handler (/app/server/api/x.ts:3:9)',
    timestamp: Date.now(),
    context: { url: '/api/orders', method: 'GET' },
    ...overrides,
  }
}

async function collect(rows: AsyncGenerator<string>): Promise<string> {
  let out = ''

  for await (const chunk of rows) {
    out += chunk
  }

  return out
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-export-'))
  store = await MonitorStore.open({
    dir,
    retentionDays: 14,
    maxEventsPerIssue: 100,
    flushSize: 1_000,
    flushInterval: 60_000,
  })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('json', () => {
  it('is valid JSON, and an array', async () => {
    store.capture(event())
    store.capture(event({ message: 'second' }))
    await store.flush()

    const parsed = JSON.parse(await collect(store.exportRows({ table: 'issues', format: 'json' })))

    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
  })

  it('is still valid JSON when there is nothing to export', async () => {
    // The empty case is the one that breaks a script written against the full
    // one, so it has to parse rather than merely be empty.
    expect(JSON.parse(await collect(store.exportRows({ table: 'issues', format: 'json' })))).toEqual([])
  })

  it('parses the JSON columns instead of nesting strings', async () => {
    store.capture(event({ tags: ['request'] }))
    await store.flush()

    const [row] = JSON.parse(await collect(store.exportRows({ table: 'events', format: 'json' })))

    // A field that is a string containing JSON forces every consumer to parse
    // twice, and the second parse is the one they forget.
    expect(row.tags).toEqual(['request'])
    expect(row.context).toMatchObject({ url: '/api/orders' })
  })

  it('leaves absent columns out rather than emitting nulls', async () => {
    store.capture(event())
    await store.flush()

    const [row] = JSON.parse(await collect(store.exportRows({ table: 'issues', format: 'json' })))

    expect('level' in row).toBe(false)
  })
})

describe('csv', () => {
  it('leads with a header, even with no rows', async () => {
    const output = await collect(store.exportRows({ table: 'issues', format: 'csv' }))

    expect(output).toBe(csvHeader('issues'))
    expect(output.split('\n')[0]).toContain('fingerprint,type,message')
  })

  it('writes one line per row', async () => {
    store.capture(event())
    await store.flush()

    const lines = (await collect(store.exportRows({ table: 'issues', format: 'csv' })))
      .trim()
      .split('\n')

    expect(lines).toHaveLength(2)
  })
})

describe('csvCell', () => {
  it('quotes what would otherwise break the row', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
  })

  it('leaves an ordinary value alone', () => {
    expect(csvCell('TypeError')).toBe('TypeError')
    expect(csvCell(42)).toBe('42')
    expect(csvCell(null)).toBe('')
  })

  it('defuses a value a spreadsheet would run as a formula', () => {
    // Error messages are attacker-influenced text, and this is the export of a
    // security tool. A cell starting `=` executes on open in Excel and Sheets.
    expect(csvCell('=1+1')).toBe(`"'=1+1"`)
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`)
    expect(csvCell('-2+3')).toBe(`"'-2+3"`)
  })
})

describe('filters', () => {
  it('honours `since`', async () => {
    store.capture(event({ timestamp: Date.now() - 10 * 24 * 60 * 60 * 1_000 }))
    store.capture(event({ message: 'recent' }))
    await store.flush()

    const output = await collect(store.exportRows({
      table: 'events',
      format: 'json',
      since: Date.now() - 24 * 60 * 60 * 1_000,
    }))

    expect(JSON.parse(output)).toHaveLength(1)
  })

  it('honours `limit`, so a click cannot start an unbounded scan', async () => {
    // Distinct call sites, not distinct messages: a number in a message is
    // normalised away on purpose, so ten of those are one issue.
    for (let i = 0; i < 10; i++) {
      store.capture(event({ stack: `TypeError: boom\n    at handler (/app/server/api/${i}.ts:3:9)` }))
    }

    await store.flush()

    const output = await collect(store.exportRows({ table: 'issues', format: 'json', limit: 3 }))

    expect(JSON.parse(output)).toHaveLength(3)
  })
})

describe('the CLI copy', () => {
  /**
   * `bin/db.mjs` repeats the column lists because the runtime ships as
   * TypeScript that a plain Node process cannot import. Duplication is only
   * acceptable while it cannot drift, which is what this checks: a column
   * added to one and not the other fails here rather than in somebody's
   * export six months later.
   */
  it('exports the same columns as the runtime', async () => {
    const cli = fileURLToPath(new URL('../../../bin/db.mjs', import.meta.url))
    const { EXPORT_COLUMNS } = await import(cli) as {
      EXPORT_COLUMNS: Record<'issues' | 'events', string[]>
    }

    for (const table of ['issues', 'events'] as const) {
      expect(`${EXPORT_COLUMNS[table].join(',')}\n`).toBe(csvHeader(table))
    }
  })
})

/**
 * Completeness against the schema, which the drift test above cannot see.
 *
 * That one compares the two hand-written lists to each other, so a column
 * missing from *both* passes it happily — which is exactly what happened when
 * `resolved_at` and `regressed_at` were added: stored, surfaced in the API and
 * shown in the UI, and absent from every export with no test failing. The
 * argument for a local-first tool is that the data is yours, and that argument
 * is only as good as the way out.
 */
describe('every stored column is exportable', () => {
  /**
   * Both tables, not just `issues`.
   *
   * The single-table version of this test is how `kind` and `request_id` were
   * stored on `events`, surfaced in the API and left out of every export with
   * nothing failing — the same drift the comment above describes, in the table
   * the test did not happen to name.
   */
  it.each(['issues', 'events'] as const)('exports every column the %s table actually has', async (table) => {
    const dir = mkdtempSync(join(tmpdir(), 'monitor-export-columns-'))
    const store = await MonitorStore.open({
      dir,
      retentionDays: 14,
      maxEventsPerIssue: 5,
      flushSize: 1_000,
      flushInterval: 60_000,
    })

    const stored = (await (store as unknown as { db: {
      prepare: (sql: string) => { all: () => Promise<{ name: string }[]> }
    } }).db.prepare(`PRAGMA table_info(${table})`).all()).map(column => column.name)

    const exported = new Set(csvHeader(table).trim().split(','))

    // Alerting bookkeeping is deliberately internal: a cooldown timestamp says
    // nothing about the error and everything about this module's own state.
    const internal = new Set(['alerted_at', 'alerted_count'])
    const missing = stored.filter(name => !exported.has(name) && !internal.has(name))

    expect(missing).toEqual([])

    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
