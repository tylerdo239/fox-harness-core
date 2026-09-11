# infra/migrations

MariaDB schema migrations. `001_init.sql` — the only file — creates the 2
real tables this app has: `users`, `sessions`.

Prod's DB server is MariaDB. This repo ran Postgres from Phase 5 through
2026-09-08; the Postgres-era migration history and the `pg` driver code
were removed entirely on 2026-09-09 (explicit instruction — not kept for
historical record).

Convention going forward: never edit `001_init.sql` once anything real has
run against it — add a new numbered file (`002_...sql`) for any schema
change instead.
