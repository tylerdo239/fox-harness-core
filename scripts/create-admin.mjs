#!/usr/bin/env node
// Phase 7: the ONLY way to create an admin account. Deliberately not an
// HTTP endpoint — a self-service register route that could ever produce an
// admin would be a real vulnerability, not a convenience
// (services/gateway/src/auth.ts's `register()` always hardcodes
// `role='user'`). Run this once per admin account needed, directly against
// MariaDB, out-of-band from the running gateway:
//
//   DATABASE_URL=... node scripts/create-admin.mjs admin@example.com 'a real password'
//
// Idempotent: re-running with the same email resets that account's password
// and (re-)promotes it to admin, rather than erroring on conflict — useful
// for rotating a lost admin password without a separate "reset" flow.
// Migrated off Postgres 2026-09-09 (docs/code-rules.md's MariaDB-migration
// section) — this script has its own inline SQL (does NOT import
// services/gateway/src/db.ts, this runs standalone outside gateway's module
// graph), so it needed its own driver+dialect rewrite too.

import { randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'
import mariadb from 'mariadb'

const scrypt = promisify(scryptCallback)

// Duplicated from services/gateway/src/password.ts — this script runs
// standalone, outside the gateway's own module graph (mirrored, not
// imported, same convention as every other small cross-boundary utility in
// this repo; see docs/code-rules.md).
async function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

const [, , email, password] = process.argv
if (!email || !password) {
  console.error('usage: node scripts/create-admin.mjs <email> <password>')
  process.exit(1)
}
if (password.length < 8) {
  console.error('password must be at least 8 characters')
  process.exit(1)
}

const databaseUrl = process.env.DATABASE_URL ?? 'mariadb://fox_harness:fox_harness_dev@127.0.0.1:3307/fox_harness'
const pool = mariadb.createPool(databaseUrl)

const passwordHash = await hashPassword(password)
// Real change 2026-09-10: `users.id` is `int auto_increment` now (was a
// `randomUUID()` this script generated itself) — no `id` column/value to
// pass anymore, MariaDB assigns it. `email`'s own `unique` constraint is
// still what the `on duplicate key update` branch keys off of, unrelated
// to `id`'s type, so the idempotent re-run behavior is unaffected.
await pool.query(
  `insert into users (email, password_hash, role) values (?, ?, 'admin')
   on duplicate key update password_hash = values(password_hash), role = 'admin'`,
  [email, passwordHash],
)
console.log(`admin account ready: ${email}`)
await pool.end()
