#!/usr/bin/env node
// One-off for docs/data-studio-user-dashboards-plan.md: dashboards, charts and Data Studio conversations made before
// 2026-10-07 have no `owner_id`, so no user's (per-user) dashboard list can show them. This gives every such document
// to one account — by default the first admin (lowest id) — or to `--owner <user id>`. Back up Mongo first.
//
//   DATABASE_URL=... MONGODB_URL=... MONGODB_DATABASE_NAME=bot_data_studio node scripts/backfill-dashboard-owners.mjs [--owner 2] [--dry-run]
//
// Idempotent: only documents without `owner_id` are touched.

import mariadb from 'mariadb'
import { MongoClient } from 'mongodb'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const ownerArg = args.includes('--owner') ? Number(args[args.indexOf('--owner') + 1]) : undefined

const databaseUrl = process.env.DATABASE_URL ?? 'mariadb://fox_harness:fox_harness_dev@127.0.0.1:3307/fox_harness'
const mongoUrl = process.env.MONGODB_URL ?? process.env.MongoDBWrite ?? 'mongodb://127.0.0.1:27017'
const mongoDb = process.env.MONGODB_DATABASE_NAME ?? 'bot_data_studio'

const pool = mariadb.createPool(databaseUrl)
let ownerId = ownerArg
if (ownerId === undefined) {
  const rows = await pool.query("select id, email from discovery_users where role = 'admin' order by id limit 1")
  if (rows.length === 0) {
    console.error('no admin account: pass --owner <user id>')
    process.exit(1)
  }
  ownerId = Number(rows[0].id)
  console.log(`owner: first admin, id ${ownerId} (${rows[0].email})`)
} else {
  const rows = await pool.query('select email from discovery_users where id = ?', [ownerId])
  if (rows.length === 0) {
    console.error(`no user with id ${ownerId}`)
    process.exit(1)
  }
  console.log(`owner: id ${ownerId} (${rows[0].email})`)
}
await pool.end()

const client = new MongoClient(mongoUrl)
await client.connect()
const db = client.db(mongoDb)
const missing = { owner_id: { $exists: false } }
for (const name of ['dashboards', 'charts', 'conversations']) {
  const count = await db.collection(name).countDocuments(missing)
  if (!dryRun && count > 0) await db.collection(name).updateMany(missing, { $set: { owner_id: ownerId } })
  console.log(`${name}: ${count} without an owner${dryRun ? ' (dry run, unchanged)' : ` -> owner ${ownerId}`}`)
}
await client.close()
