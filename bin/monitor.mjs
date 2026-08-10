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

function usage() {
  console.log(`
  monitor hash-password [password]

    Prints a scrypt hash for \`monitor.auth.passwordHash\`, so the plaintext
    password never has to appear in your config or your build output.

    Reads from a prompt when no password is given, which keeps it out of
    shell history.
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

  usage()
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 1)
}

await main()
