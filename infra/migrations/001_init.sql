-- MariaDB schema (target: MariaDB 10.11 LTS). Prod's DB server is
-- MariaDB — this repo ran Postgres from Phase 5 through 2026-09-08; the
-- Postgres-era migration files and the `pg` driver code have been removed
-- entirely (2026-09-09), not kept as history, per explicit instruction.
-- Only 2 tables: users, sessions. Run on an empty database; users must be
-- created before sessions (sessions.owner_id has a foreign key to users.id).
--
-- Dialect choices worth knowing:
--   * `text` primary/foreign-key columns -> sized `varchar` (session_id is
--     a UUID -> varchar(36); email -> varchar(255); role's values are just
--     'admin'/'user' -> varchar(16)). `title` -> `varchar(255)` (2026-09-10
--     — was unsized `text`; the only writer, `renameSession()` in
--     services/gateway/src/db.ts, already truncates to 200 chars before
--     insert, so this is a real, safe constraint, not just documentation).
--   * `users.id` -> `int auto_increment` (2026-09-10 — was `varchar(36)`
--     UUID; user requested int ids). `sessions.owner_id` (the FK) follows
--     the same type change; `sessions.session_id` itself deliberately
--     STAYS a UUID — it's used as the WS route (`/sessions/<id>`), the
--     `/chat/<id>` URL, and the real on-disk directory name
--     (`data/dsh-home/<id>/...`) across gateway/orchestrator/transport/the
--     FE, none of which this change touches; an auto-increment session id
--     would also make session URLs sequential/guessable, a real regression
--     from today's non-enumerable UUIDs. Confirmed this narrower scope
--     with the user before implementing — "chỉ users.id" (only users.id).
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
--   * `engine=innodb` explicit on both tables — MariaDB's default anyway,
--     but explicit here since the foreign key requires it.

create table if not exists users (
  id int auto_increment primary key,
  email varchar(255) not null unique,
  password_hash text not null,
  role varchar(16) not null default 'user' check (role in ('admin', 'user')),
  created_at datetime not null default current_timestamp
) engine=innodb;

-- Foreign key written as an explicit table-level `constraint ... foreign
-- key` clause, not inline column-level `references` — MySQL/MariaDB parse
-- inline `references` on a column but do NOT enforce it as a real
-- constraint on InnoDB (unlike Postgres, where inline `references` is
-- fully equivalent). The explicit clause is unambiguous on both engines.
create table if not exists sessions (
  session_id varchar(36) primary key,
  owner_id int not null,
  created_at datetime not null default current_timestamp,
  title varchar(255),
  updated_at datetime not null default current_timestamp,
  first_message_at datetime,
  constraint sessions_owner_id_fkey foreign key (owner_id) references users (id)
) engine=innodb;

create index if not exists sessions_owner_id_updated_at_idx on sessions (owner_id, updated_at desc);
