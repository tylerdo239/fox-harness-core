// Real password hashing — Node's built-in `crypto.scrypt` (a memory-hard
// KDF, the same primitive bcrypt/argon2 exist to provide), not a native
// module (bcrypt/argon2 both ship native bindings — this repo has already
// been burned once by a native-module portability problem, node-pty on
// Alpine/musl, docs/code-rules.md §17 bug #3; scrypt needs nothing beyond
// what Node already ships, and Node's own crypto docs use this exact
// recipe as the recommended password-hashing pattern). Stored format:
// `<salt-hex>:<hash-hex>`, one column, no separate salt column needed.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const derived = await scrypt(password, salt, expected.length)
  return expected.length === derived.length && timingSafeEqual(expected, derived)
}
