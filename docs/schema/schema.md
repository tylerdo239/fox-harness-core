# fox-harness-core — database schema

For handing to whoever provisions the database. The actual DDL to run is
`001_init.sql` in this same folder (canonical source:
`infra/migrations/001_init.sql` in the app repo — copied here for
sharing convenience, keep both in sync if the schema changes).

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

Only 2 tables. `users` must exist before `sessions` (foreign key).

### `users`

| Column | Type | Constraints |
|---|---|---|
| `id` | `int` | PRIMARY KEY, AUTO_INCREMENT |
| `email` | `varchar(255)` | NOT NULL, UNIQUE |
| `password_hash` | `text` | NOT NULL |
| `role` | `varchar(16)` | NOT NULL, DEFAULT `'user'`, CHECK IN (`'admin'`, `'user'`) |
| `created_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |

### `sessions`

`session_id` deliberately stays a UUID (`varchar(36)`), not `int` — it's
used as the app's real routing key (WebSocket path, browser URL) and as an
on-disk directory name, so it needs to be non-sequential/non-guessable and
assignable before any database row exists, which an auto-increment column
can't do. Only `users.id`/`sessions.owner_id` (internal-only, never
exposed in a URL or file path) are `int`.

| Column | Type | Constraints |
|---|---|---|
| `session_id` | `varchar(36)` | PRIMARY KEY (UUID) |
| `owner_id` | `int` | NOT NULL, FOREIGN KEY → `users.id` |
| `created_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |
| `title` | `varchar(255)` | nullable |
| `updated_at` | `datetime` | NOT NULL, DEFAULT `current_timestamp` |
| `first_message_at` | `datetime` | nullable |

Index: `(owner_id, updated_at DESC)` — supports "list a user's sessions,
newest first".

## After setup

Send back: **host, port, username, password** (database name is fixed —
`discovery-agent`, see above). They get combined into one connection
string, set as the app's `DATABASE_URL`:

```
DATABASE_URL=mariadb://<user>:<password>@<host>:<port>/discovery-agent
```

The `mariadb://` scheme is required as written (the driver rejects anything
else).
