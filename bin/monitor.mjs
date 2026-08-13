#!/usr/bin/env node

/**
 * `npx monitor …`
 *
 * Only what has to live outside a running server. Anything the dashboard can
 * answer belongs in the dashboard, where it has context; the one thing it
 * cannot do is hash a password you have not set yet.
 */

import { scryptSync, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { open, quote, rows } from './db.mjs'

const [command, ...rest] = process.argv.slice(2)

/**
 * Must match `hashPassword` in the runtime.
 *
 * Duplicated rather than imported: this runs from `npx` against the published
 * package, where importing runtime TypeScript would mean shipping a build step
 * for one function. The format carries its own parameters, so a hash made here
 * stays verifiable even if these constants change later.
 */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 }
const SCRYPT_KEYLEN = 64
const SALT_BYTES = 16

function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)
  const { N, r, p } = SCRYPT_PARAMS

  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$')
}

async function readPassword() {
  const given = rest.find(argument => !argument.startsWith('-'))

  if (given) {
    return given
  }

  // Prompted rather than taken from `argv` when possible: a password on the
  // command line ends up in shell history and in the process list.
  const rl = createInterface({ input: process.stdin, output: process.stderr })

  try {
    return (await rl.question('Password: ')).trim()
  }
  finally {
    rl.close()
  }
}

/** `--dir .monitor`, `--format csv`, `--days 30`. */
function flag(name, fallback) {
  const index = rest.indexOf(`--${name}`)

  if (index === -1) {
    return fallback
  }

  const value = rest[index + 1]

  return value === undefined || value.startsWith('--') ? true : value
}

/**
 * Counts, in the shape somebody asks for them over SSH.
 *
 * The dashboard answers this better and with context, which is exactly why
 * this stays a summary rather than growing into a second dashboard: what it is
 * for is the case where the dashboard is not reachable — a cron box, a
 * container with no port published, a server somebody is already logged into.
 */
async function stats() {
  const { db, dialect, label, close } = await open({ dir: flag('dir'), url: flag('url') })

  try {
    const one = async (sql) => {
      const row = await db.prepare(quote(sql, dialect)).get()

      return Number(Object.values(row ?? {})[0] ?? 0)
    }

    const issues = await one('SELECT COUNT(*) AS n FROM issues')
    const events = await one('SELECT COUNT(*) AS n FROM events')
    const unresolved = await one('SELECT COUNT(*) AS n FROM issues WHERE resolved = 0 AND (ignored IS NULL OR ignored = 0)')
    const oldest = await one('SELECT MIN(ts) AS n FROM events')
    const newest = await one('SELECT MAX(ts) AS n FROM events')

    const rows = await db.prepare(quote(
      'SELECT type, message, count, last_seen FROM issues ORDER BY count DESC LIMIT 5',
      dialect,
    )).all()

    console.log(`  ${label}\n`)
    console.log(`  issues       ${issues} (${unresolved} open)`)
    console.log(`  events       ${events}`)

    if (oldest && newest) {
      console.log(`  span         ${new Date(oldest).toISOString()} … ${new Date(newest).toISOString()}`)
    }

    if (rows.length) {
      console.log('\n  Most frequent:')

      for (const row of rows) {
        const message = String(row.message ?? '').replace(/\s+/g, ' ').slice(0, 60)

        console.log(`    ${String(row.count).padStart(7)}  ${row.type}: ${message}`)
      }
    }
  }
  finally {
    await close()
  }
}

/**
 * Deletes events past a cutoff, and the issues left with none.
 *
 * The server applies retention on a timer, so this exists for the times that
 * is not enough: a limit lowered after the fact, a database that grew while
 * nobody was looking, a copy taken for support that should not keep last
 * month. Prints what it would do unless `--yes` is given — this is the one
 * command here that destroys anything.
 */
async function purge() {
  const days = Number(flag('days', 14))

  if (!Number.isFinite(days) || days < 0) {
    throw new Error('`--days` must be a number of days to keep.')
  }

  const { db, dialect, label, close } = await open({ dir: flag('dir'), url: flag('url') })
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1_000

  try {
    const doomed = await db.prepare(quote('SELECT COUNT(*) AS n FROM events WHERE ts < ?', dialect)).get(cutoff)
    const count = Number(Object.values(doomed ?? {})[0] ?? 0)

    if (flag('yes') !== true) {
      console.log(`  ${label}`)
      console.log(`  ${count} event${count === 1 ? '' : 's'} older than ${days} day${days === 1 ? '' : 's'} would be deleted.`)
      console.log('  Re-run with --yes to do it.')
      return
    }

    await db.prepare(quote('DELETE FROM events WHERE ts < ?', dialect)).run(cutoff)

    // Issues whose every occurrence has gone would otherwise linger as rows
    // nothing can reach.
    await db.prepare(quote(
      'DELETE FROM issues WHERE fingerprint NOT IN (SELECT DISTINCT fingerprint FROM events)',
      dialect,
    )).run()

    // Returns freed pages to the filesystem. Without it the measured size
    // drops and the file on disk does not, and the disk is what runs out.
    if (dialect === 'sqlite') {
      await db.exec('VACUUM').catch(() => {})
    }

    console.log(`  Deleted ${count} event${count === 1 ? '' : 's'} older than ${days} day${days === 1 ? '' : 's'}.`)
  }
  finally {
    await close()
  }
}

/**
 * Writes the data to stdout, so it can be redirected or piped.
 *
 * The dashboard has a download button that does the same thing; this is for
 * the case where there is no browser in the loop — a backup script, a
 * migration, a support bundle.
 */
async function exportData() {
  const table = flag('table', 'issues') === 'events' ? 'events' : 'issues'
  const format = flag('format', 'json') === 'csv' ? 'csv' : 'json'
  const days = Number(flag('days', 0))
  const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1_000 : undefined

  const { db, dialect, close } = await open({ dir: flag('dir'), url: flag('url') })

  try {
    for await (const chunk of rows(db, dialect, { table, format, since })) {
      process.stdout.write(chunk)
    }
  }
  finally {
    await close()
  }
}

function usage() {
  console.log(`
  monitor hash-password [password]

    Prints a scrypt hash for \`monitor.auth.passwordHash\`, so the plaintext
    password never has to appear in your config or your build output.

    Reads from a prompt when no password is given, which keeps it out of
    shell history.

  monitor stats [--dir .monitor] [--url <database-url>]

    Counts and the most frequent issues. For when the dashboard is not
    reachable — a cron box, a container with no port published.

  monitor purge [--days 14] [--yes] [--dir .monitor]

    Deletes events older than --days and the issues left with none. Prints
    what it would delete unless --yes is given.

  monitor export [--table issues|events] [--format json|csv] [--days N]

    Writes the data to stdout. Your data is yours; this is the way out.

  Every command reads NUXT_MONITOR_DATABASE_URL and NUXT_MONITOR_STORAGE_DIR
  when the matching flag is absent.
`)
}

async function main() {
  if (command === 'hash-password') {
    const password = await readPassword()

    if (!password) {
      console.error('No password given.')
      process.exit(1)
    }

    // The hash to stdout and nothing else, so it can be piped.
    console.log(hashPassword(password))
    return
  }

  const commands = { stats, purge, export: exportData }

  if (commands[command]) {
    try {
      await commands[command]()
    }
    catch (error) {
      // The message alone, not a stack: these failures are about a path or a
      // URL being wrong, and a trace through db0 helps nobody fix that.
      console.error(`  ${error instanceof Error ? error.message : error}`)
      process.exit(1)
    }

    return
  }

  usage()
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 1)
}

await main()
