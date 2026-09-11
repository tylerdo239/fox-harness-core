// MariaDB client (Phase 7 — real users + session ownership; Phase 12 item 2
// — the same table becomes a real, user-listable session directory; migrated
// off Postgres 2026-09-09 — prod's DB server is MariaDB, and `pg` speaks the
// Postgres wire protocol only, so this couldn't be a connection-string
// change). `mariadb`, the same "one focused client per real protocol"
// choice this repo already made for `ws`/`ioredis`/`dockerode` rather than
// an ORM. Schema: infra/migrations/001_init.sql.

import mariadb from 'mariadb'

import { config } from './config.ts'

// Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
// finding #6): parsed into discrete fields instead of passing
// `config.databaseUrl` straight through as a string — needed to also set
// `connectionLimit`, which a `?connectionLimit=N` query param on the
// connection string does NOT reliably reach (verified empirically against
// the real running MariaDB: with the string form, `pool.opts` couldn't
// even be inspected to check; with THIS discrete-object form, a real test —
// 5 concurrent queries against a pool built with `connectionLimit: 2` —
// confirmed `totalConnections()` never exceeded 2). Field names confirmed
// against `node_modules/mariadb/lib/config/connection-options.js`'s own
// real URL parser (host/port/user/password/database), not guessed.
const dbUrl = new URL(config.databaseUrl)
const pool = mariadb.createPool({
  host: dbUrl.hostname,
  port: dbUrl.port ? Number(dbUrl.port) : undefined,
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, ''),
  connectionLimit: config.dbConnectionLimit,
})

export type Role = 'admin' | 'user'

export interface UserRecord {
  id: number
  email: string
  passwordHash: string
  role: Role
  createdAt: string
}

export interface PublicUser {
  id: number
  email: string
  role: Role
  createdAt: string
}

interface UserRow {
  id: number
  email: string
  password_hash: string
  role: Role
  created_at: string
}

function toUser(row: UserRow): UserRecord {
  return { id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role, createdAt: row.created_at }
}

// Real change 2026-09-10 (user request — "các cột id nên là type int"):
// `id` used to be a `randomUUID()` the CALLER generated and passed in; now
// it's `int auto_increment` (infra/migrations/001_init.sql), so the DB
// assigns it and this no longer takes an `id` param at all. `RETURNING *`
// (MariaDB 10.5+, confirmed target is 10.11) hands back the real assigned
// id in the same round trip, same mechanism this function already used.
export async function createUser(email: string, passwordHash: string, role: Role): Promise<UserRecord> {
  const rows = await pool.query<UserRow[]>(
    `insert into users (email, password_hash, role) values (?, ?, ?) returning *`,
    [email, passwordHash, role],
  )
  return toUser(rows[0])
}

export async function getUserByEmail(email: string): Promise<UserRecord | undefined> {
  const rows = await pool.query<UserRow[]>(`select * from users where email = ?`, [email])
  return rows[0] ? toUser(rows[0]) : undefined
}

export async function getUserById(id: number): Promise<UserRecord | undefined> {
  const rows = await pool.query<UserRow[]>(`select * from users where id = ?`, [id])
  return rows[0] ? toUser(rows[0]) : undefined
}

// Never selects password_hash — this is the admin-listing surface
// (GET /users), never meant to carry hashes over the wire even to an admin.
export async function listUsers(): Promise<PublicUser[]> {
  const rows = await pool.query<{ id: number; email: string; role: Role; created_at: string }[]>(
    `select id, email, role, created_at from users order by created_at`,
  )
  return rows.map((row) => ({ id: row.id, email: row.email, role: row.role, createdAt: row.created_at }))
}

// Idempotent by design (`insert ignore`, MariaDB's equivalent of Postgres's
// `on conflict do nothing`) — the WS upgrade handler (index.ts) calls this
// once right after a brand-new session is created; a retried/duplicate call
// must never silently reassign ownership.
export async function createSession(sessionId: string, ownerId: number): Promise<void> {
  await pool.query(`insert ignore into sessions (session_id, owner_id) values (?, ?)`, [sessionId, ownerId])
}

export async function getSessionOwnerId(sessionId: string): Promise<number | undefined> {
  const rows = await pool.query<{ owner_id: number }[]>(`select owner_id from sessions where session_id = ?`, [sessionId])
  return rows[0]?.owner_id
}

// Real gap fixed 2026-09-09 (infra/migrations/001_init.sql): called
// once, the first time a real client->worker WS frame passes through the
// gateway's proxy (services/gateway/src/proxy.ts) for this session —
// `WHERE ... IS NULL` makes a repeat call (a later message on the same
// session) a safe no-op, not a re-write. `listSessionsForOwner` below only
// returns rows where this is set, so a session opened but never actually
// used never shows up in the sidebar's real session list at all.
export async function markSessionFirstMessage(sessionId: string): Promise<void> {
  await pool.query(`update sessions set first_message_at = now() where session_id = ? and first_message_at is null`, [
    sessionId,
  ])
}

// Phase 6's real delete-on-request (services/orchestrator's `purgeSession`)
// deletes the session's data; this is gateway's own matching bookkeeping
// cleanup, called right after a successful purge (index.ts) so a
// purged-then-recreated session id can't inherit stale ownership/title.
export async function deleteSessionRow(sessionId: string): Promise<void> {
  await pool.query(`delete from sessions where session_id = ?`, [sessionId])
}

export interface SessionOwnerRow {
  sessionId: string
  ownerId: number
  createdAt: string
}

// Phase 7's admin listing (GET /sessions) — kept minimal (no title/updated_at
// projection) since it existed before Phase 12 and nothing depends on the
// richer shape; a regular user's OWN listing is `listSessionsForOwner` below.
export async function listSessionOwners(): Promise<SessionOwnerRow[]> {
  const rows = await pool.query<{ session_id: string; owner_id: number; created_at: string }[]>(
    `select session_id, owner_id, created_at from sessions order by created_at`,
  )
  return rows.map((row) => ({ sessionId: row.session_id, ownerId: row.owner_id, createdAt: row.created_at }))
}

export interface OwnedSessionRow {
  sessionId: string
  title: string | null
  createdAt: string
  updatedAt: string
}

// Phase 12 item 2: GET /sessions/mine — the route that didn't exist before
// this phase at all. Ordered newest-activity-first, matching dsh's real
// `dsh-client-ui-workspace`'s `orderBy: "updated"` flat mode (this project's
// deliberately chosen v1 — no workspace/folder grouping, see the roadmap).
// `first_message_at is not null` added 2026-09-09 (infra/migrations/001_init.sql)
// — a session opened but never actually chatted in
// (every logout->login opens a fresh one, App.tsx's own comment on why) no
// longer clutters this list.
export async function listSessionsForOwner(ownerId: number): Promise<OwnedSessionRow[]> {
  const rows = await pool.query<{ session_id: string; title: string | null; created_at: string; updated_at: string }[]>(
    `select session_id, title, created_at, updated_at from sessions where owner_id = ? and first_message_at is not null order by updated_at desc`,
    [ownerId],
  )
  return rows.map((row) => ({ sessionId: row.session_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }))
}

// Phase 12 item 2: PATCH /sessions/:id {title} — the rename action the
// sidebar's session-list rows expose. `updated_at` bumps too (a rename is
// itself activity, matching the "updated" sort's intuitive meaning).
export async function renameSession(sessionId: string, title: string): Promise<void> {
  await pool.query(`update sessions set title = ?, updated_at = now() where session_id = ?`, [title, sessionId])
}

// Phase 12 item 2: called on every real client->worker message (index.ts,
// via proxy.ts's `onEveryClientMessage`) so a session a user is actually
// USING climbs back to the top of their "updated" list — the whole point of
// sorting by updated_at instead of created_at. Deliberately NOT called on
// bare WS connect (real bug fixed 2026-09-10 — used to be, which meant just
// opening an old chat to read it, no message sent, bumped it to the top and
// visibly jumped that row in the sidebar the instant it was clicked).
export async function touchSessionRow(sessionId: string): Promise<void> {
  await pool.query(`update sessions set updated_at = now() where session_id = ?`, [sessionId])
}
