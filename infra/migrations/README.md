# infra/migrations

MariaDB schema migrations. `001_init.sql` — the only file — creates the 3
real tables this app has: `users`, `sessions`, `custom_skills`.

Prod's DB server is MariaDB. This repo ran Postgres from Phase 5 through
2026-09-08; the Postgres-era migration history and the `pg` driver code
were removed entirely on 2026-09-09 (explicit instruction — not kept for
historical record).

Convention: `001_init.sql` is the single canonical schema file, kept
up to date in place — this project has exactly one real deployment (no
external installs whose history a numbered-migration trail would need to
preserve), so a schema change edits `001_init.sql` directly and is applied
to the live DB with the matching `ALTER TABLE` by hand, rather than adding
a new numbered file. (2026-09-09 through 2026-09-14 this repo instead used
numbered follow-up files — `002_custom_skills.sql`, `003_add_flow_column.sql`,
`004_password_hash_length_and_session_id_pk.sql` — folded back into
`001_init.sql` on 2026-09-14 once it was clear that trail wasn't earning
its cost here. If this project ever gets a second real deployment/environment
that needs to replay schema history independently, reintroduce numbered
migration files at that point instead of applying this convention.)
