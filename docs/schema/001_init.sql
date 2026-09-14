-- MariaDB schema (target: MariaDB 10.11 LTS). Prod's DB server is
-- MariaDB — this repo ran Postgres from Phase 5 through 2026-09-08; the
-- Postgres-era migration files and the `pg` driver code have been removed
-- entirely (2026-09-09), not kept as history, per explicit instruction.
-- 3 tables: users, sessions, custom_skills. Run on an empty database; users
-- must be created before sessions/custom_skills (both have a foreign key
-- to users.id).
--
-- Consolidated 2026-09-14: this file used to be 001_init.sql plus 3
-- follow-up ALTER migrations (002_custom_skills.sql, 003_add_flow_column.sql,
-- 004_password_hash_length_and_session_id_pk.sql) — folded back into one
-- file since this project has exactly one real deployment (this dev DB) and
-- no external installs to keep an incremental migration trail for. Anyone
-- provisioning a FRESH database only ever needs this one file now; the 3
-- follow-up files no longer exist (see infra/migrations/README.md). The
-- live DB itself already has all 4 migrations applied — this consolidation
-- changes nothing there, only what a brand-new install runs.
--
-- Dialect choices worth knowing:
--   * `text` primary/foreign-key columns -> sized `varchar` (session_id is
--     a UUID -> varchar(36); email -> varchar(255); role's values are just
--     'admin'/'user' -> varchar(16)). `title` -> `varchar(255)` (2026-09-10
--     — was unsized `text`; the only writer, `renameSession()` in
--     services/gateway/src/db.ts, already truncates to 200 chars before
--     insert, so this is a real, safe constraint, not just documentation).
--   * `password_hash` -> `varchar(161)` (2026-09-14 — was unsized `text`):
--     fixed length always, in practice — `services/gateway/src/password.ts`
--     stores `<salt-hex>:<hash-hex>` from `crypto.scrypt` with a hardcoded
--     16-byte salt and 64-byte derived key: 32 hex chars + 1 `:` + 128 hex
--     chars = 161 chars exactly, every time.
--   * `users.id` -> `int auto_increment` (2026-09-10 — was `varchar(36)`
--     UUID; user requested int ids). `sessions.owner_id`/`custom_skills.owner_id`
--     (both FKs) follow the same type change.
--   * `sessions.session_id` itself deliberately STAYS a UUID (`varchar(36)`,
--     UNIQUE, not the table's PRIMARY KEY) — it's used as the WS route
--     (`/sessions/<id>`), the `/chat/<id>` URL, the real on-disk directory
--     name (`data/dsh-home/<id>/...`), and the Redis affinity key
--     (`fh:session:<id>`) across gateway/orchestrator/transport/the FE,
--     none of which this schema touches. An auto-increment session id
--     would make session URLs sequential/guessable, a real regression from
--     today's non-enumerable UUIDs — confirmed narrow scope with the user
--     twice: first "chỉ users.id" (2026-09-10, session_id stays UUID
--     entirely), then again 2026-09-14 when a separate "sessions needs an
--     int primary key" requirement came in — resolved by giving `sessions`
--     a SURROGATE `id int auto_increment primary key` instead of changing
--     `session_id`'s type/value/role at all: `session_id` is now a UNIQUE
--     key, not the PK, but every application query still filters on it
--     (`where session_id = ?`), never on `id` — no code anywhere reads or
--     writes the surrogate `id` column.
--     `services/gateway/src/db.ts`'s `createUser()` no longer takes an id
--     param — MariaDB assigns it, returned via the same `RETURNING *` this
--     file's own `insert ... returning *` note below already relies on.
--   * `timestamptz` -> `datetime`, not MariaDB `timestamp` (`timestamp`
--     tops out at 2038-01-19 UTC; `datetime` with `default
--     current_timestamp` behaves the same for our purposes with no range
--     limit).
--   * `check (role in (...))` kept verbatim — MariaDB 10.2+ supports CHECK
--     constraints natively; target is 10.11.
--   * `create index ... (owner_id, updated_at desc)` and `if not exists`
--     kept verbatim — true DESC indexes need MariaDB 10.8+, `CREATE INDEX
--     IF NOT EXISTS` needs 10.5.2+; both fine at the confirmed 10.11
--     target.
--   * `engine=innodb` explicit on every table — MariaDB's default anyway,
--     but explicit here since the foreign keys require it.

create table if not exists users (
  id int auto_increment primary key,
  email varchar(255) not null unique,
  password_hash varchar(161) not null,
  role varchar(16) not null default 'user' check (role in ('admin', 'user')),
  created_at datetime not null default current_timestamp
) engine=innodb;

-- Foreign key written as an explicit table-level `constraint ... foreign
-- key` clause, not inline column-level `references` — MySQL/MariaDB parse
-- inline `references` on a column but do NOT enforce it as a real
-- constraint on InnoDB (unlike Postgres, where inline `references` is
-- fully equivalent). The explicit clause is unambiguous on both engines.
--
-- `id` (surrogate int PRIMARY KEY) and `session_id` (the real UUID
-- identifier, UNIQUE) — see this file's header comment for the full
-- rationale for keeping both. `flow` (2026-09-14,
-- docs/data-analysis-flow-plan.md): which agent loop/profile this session
-- was created with, chosen once and carried unchanged through every
-- rehydrate (services/orchestrator's Redis record is the operational
-- source of truth for a running session, not this column) — 'default' for
-- every session created before this column existed.
create table if not exists sessions (
  id int auto_increment primary key,
  session_id varchar(36) not null unique,
  owner_id int not null,
  created_at datetime not null default current_timestamp,
  title varchar(255),
  updated_at datetime not null default current_timestamp,
  first_message_at datetime,
  flow varchar(64) not null default 'default',
  constraint sessions_owner_id_fkey foreign key (owner_id) references users (id)
) engine=innodb;

create index if not exists sessions_owner_id_updated_at_idx on sessions (owner_id, updated_at desc);

-- Per-user skills (docs/skill-transfer-plan.md, giai đoạn 2). Owned by
-- services/gateway; services/orchestrator only ever receives the rendered
-- files for a session, never owner_id.
--
-- Limits mirror services/gateway/src/skills.ts (name ≤ 64, description ≤ 280;
-- content ≤ 64 KB is checked there).
--
-- `content_key` (2026-09-14, was `content mediumtext`): actual skill
-- content moved off MariaDB onto S3 (services/gateway/src/object-storage.ts)
-- — this column only holds the stable object key
-- (`custom-skills/<owner_id>/<name>`, see `skillContentKey()`), never the
-- content itself. `varchar(255)` comfortably covers that key shape (S3 keys
-- max out at 1024 bytes, but this app's own keys are always short and
-- predictable — no need to size for the protocol's own ceiling).
--
-- `id` (surrogate int PRIMARY KEY, 2026-09-14) + `(owner_id, name)` as a
-- UNIQUE key instead of the PK, same reasoning as `sessions.id`/`session_id`
-- above: no code anywhere addresses a skill by an int id (every query in
-- services/gateway/src/db.ts looks up by `(owner_id, name)`), so this is
-- purely to give the table an `int` primary key without disturbing the
-- real key the app uses. `createCustomSkill()`'s duplicate-name detection
-- (`errno === 1062`) still works unchanged — MariaDB raises the same
-- ER_DUP_ENTRY code for a violated UNIQUE key as for a violated PRIMARY KEY.
-- (On the live already-migrated DB, dropping the old composite PRIMARY KEY
-- before adding this UNIQUE key failed with errno 150 — InnoDB requires an
-- index with `owner_id` as its leading column to keep supporting the FK
-- below, and the composite PK was the only one; the ADD UNIQUE KEY had to
-- run BEFORE the DROP PRIMARY KEY. Doesn't apply to a fresh install: this
-- CREATE TABLE declares the final shape directly.)
create table if not exists custom_skills (
  id int auto_increment primary key,
  owner_id int not null,
  name varchar(64) not null,
  description varchar(280) not null,
  content_key varchar(255) not null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp,
  unique key custom_skills_owner_id_name_key (owner_id, name),
  constraint custom_skills_owner_id_fkey foreign key (owner_id) references users (id) on delete cascade
) engine=innodb;
