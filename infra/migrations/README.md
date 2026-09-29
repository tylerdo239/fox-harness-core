# infra/migrations

MariaDB schema migrations, run by hand in order (`mariadb ... < NNN_*.sql`):

- `001_init.sql` — the base schema: `users`, `sessions`, `custom_skills`.
- `002_projects_title_source.sql` — table `projects`; columns
  `sessions.title_source` and `sessions.project_id`.

Prod's DB server is MariaDB. This repo ran Postgres from Phase 5 through
2026-09-08; the Postgres-era migration history and the `pg` driver code
were removed entirely on 2026-09-09 (explicit instruction — not kept for
historical record).

Convention (2026-09-15): a file that has been handed over or applied
somewhere is never edited. `001_init.sql` went to the team provisioning
prod, so every schema change is a new numbered file that only adds to what
the earlier files created, written with `if not exists` so running it twice
is harmless. (2026-09-09 through 2026-09-14 this repo used numbered files,
then folded them into `001_init.sql` and edited it in place while the dev
database was the only deployment; prod ended that.)
