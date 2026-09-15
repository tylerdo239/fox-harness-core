# fox-harness-core — database schema

For handing to whoever provisions the database. The actual DDL to run is
the numbered files in this same folder, in order: `001_init.sql`, then
`002_projects_title_source.sql` (canonical source: `infra/migrations/` in
the app repo — copied here for sharing convenience, keep both in sync). A
database already created from `001_init.sql` only needs `002`.

## Requirements

- **Engine:** MariaDB, version **10.11** (tested against) — 10.5+ should
  work, but constraint support (`CHECK`, `CREATE INDEX IF NOT EXISTS`, a
  real `DESC` index) is version-gated, so 10.11 is the safe target.
- **1 empty database named `discovery-agent`.** Contains a hyphen — needs
  backtick-quoting in raw SQL/CLI (`` `discovery-agent` ``), but works fine
  as a plain path segment in the connection string below.
- **1 user** with `CREATE`, `ALTER`, `INDEX`, `INSERT`/`SELECT`/`UPDATE`/
  `DELETE` on that database — no instance-wide/admin privileges needed.

## Tables

4 tables. `users` must exist before `sessions`/`projects`/`custom_skills`
(all have a foreign key to `users.id`).

### `users`

| Column | Type | Constraints |
|---|---|---|
| `id` | `int` | PRIMARY KEY, AUTO_INCREMENT |
| `email` | `varchar(255)` | NOT NULL, UNIQUE |
| `password_hash` | `varchar(161)` | NOT NULL |
| `role` | `varchar(16)` | NOT NULL, DEFAULT `'user'`, CHECK IN (`'admin'`, `'user'`) |
| `created_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |

### `sessions`

`session_id` deliberately stays a UUID (`varchar(36)`), not `int` — it's
used as the app's real routing key (WebSocket path, browser URL) and as an
on-disk directory name, so it needs to be non-sequential/non-guessable and
assignable before any database row exists, which an auto-increment column
can't do. `id` (`int`) is a surrogate PRIMARY KEY only — added so the table
has an `int` primary key without disturbing `session_id`'s value or role;
no application code queries by it, every query still filters on
`session_id` (unique-indexed, not the PK). Only `users.id`/`sessions.owner_id`
(internal-only, never exposed in a URL or file path) are otherwise `int`.

| Column | Type | Constraints |
|---|---|---|
| `id` | `int` | PRIMARY KEY, AUTO_INCREMENT (surrogate only, see above) |
| `session_id` | `varchar(36)` | UNIQUE, NOT NULL (UUID — the real identifier) |
| `owner_id` | `int` | NOT NULL, FOREIGN KEY → `users.id` |
| `created_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |
| `title` | `varchar(255)` | nullable |
| `title_source` | `varchar(16)` | nullable — `user` / `fallback` / `provider`; an automatic title never replaces a `user` one (added by `002`) |
| `updated_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |
| `first_message_at` | `datetime` | nullable |
| `flow` | `varchar(64)` | NOT NULL, DEFAULT `'default'` |
| `project_id` | `varchar(36)` | nullable — `projects.project_id` of a data-analysis chat inside a project (no foreign key) (added by `002`) |

Indexes: `(owner_id, updated_at DESC)` — supports "list a user's sessions,
newest first"; `(project_id)` — a project's chats (added by `002`).

### `projects`

Created by `002_projects_title_source.sql`. A named shared data folder for a user's data-analysis chats (files live on
disk under `data/projects/<project_id>`, not in the database). `project_id` is
a UUID for the same reason as `sessions.session_id`; `id` is a surrogate
PRIMARY KEY only.

| Column | Type | Constraints |
|---|---|---|
| `id` | `int` | PRIMARY KEY, AUTO_INCREMENT (surrogate only) |
| `project_id` | `varchar(36)` | UNIQUE, NOT NULL (UUID) |
| `owner_id` | `int` | NOT NULL, FOREIGN KEY → `users.id` ON DELETE CASCADE |
| `name` | `varchar(120)` | NOT NULL |
| `created_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |
| `updated_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |

### `custom_skills`

Per-user skills. `id` is a surrogate PRIMARY KEY only (same reasoning as
`sessions.id`/`session_id` above — no code addresses a skill by it, every
query filters on `(owner_id, name)`). `(owner_id, name)` is UNIQUE instead —
a user can't have two skills with the same name; `createCustomSkill()`
still detects that via the same `errno 1062` a violated UNIQUE key raises.

`content` (2026-09-14) no longer lives in this table — it's on S3 (or an
S3-compatible service), written/read by `services/gateway/src/object-storage.ts`.
`content_key` is the only trace of it here.

| Column | Type | Constraints |
|---|---|---|
| `id` | `int` | PRIMARY KEY, AUTO_INCREMENT (surrogate only, see above) |
| `owner_id` | `int` | UNIQUE (composite), FOREIGN KEY → `users.id` ON DELETE CASCADE |
| `name` | `varchar(64)` | UNIQUE (composite) |
| `description` | `varchar(280)` | NOT NULL |
| `content_key` | `varchar(255)` | NOT NULL — object-storage key, not the content itself |
| `created_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |
| `updated_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |

## After setup

Send back: **host, port, username, password** (database name is fixed —
`discovery-agent`, see above). They get combined into one connection
string, set as the app's `DATABASE_URL`:

```
DATABASE_URL=mariadb://<user>:<password>@<host>:<port>/discovery-agent
```

The `mariadb://` scheme is required as written (the driver rejects anything
else).
