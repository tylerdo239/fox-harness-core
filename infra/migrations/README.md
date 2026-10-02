# infra/migrations

MariaDB schema, run by hand (`mariadb ... < 001_init.sql`):

- `001_init.sql` — the whole current schema in one file: `discovery_users`,
  `discovery_sessions` (incl. `title_source`, `model`, `project_id`), `discovery_projects`,
  `discovery_custom_skills`.

Consolidated 2026-10-02: `002_projects_title_source.sql` was folded into
`001_init.sql` and deleted. A fresh database only ever needs `001_init.sql`.
A database created from the *previous* `001_init.sql` and never given `002`
can be brought up to date by running the statements below once (all are
`if not exists`, so re-running is harmless). The schema has no foreign keys
(the owning system does not want them); `owner_id` integrity is enforced by
services/gateway, and nothing deletes a user:

```sql
alter table discovery_sessions add column if not exists title_source varchar(16) after title;
alter table discovery_sessions add column if not exists model varchar(200) after flow;
alter table discovery_sessions add column if not exists project_id varchar(36) after model;
create index if not exists sessions_project_id_idx on discovery_sessions (project_id);
create table if not exists discovery_projects (
  id int auto_increment primary key,
  project_id varchar(36) not null unique,
  owner_id int not null,
  name varchar(120) not null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp,
  index projects_owner_id_idx (owner_id)
) engine=innodb;
```

Prod's DB server is MariaDB. This repo ran Postgres from Phase 5 through
2026-09-08; the Postgres-era migration history and the `pg` driver code
were removed entirely on 2026-09-09 (explicit instruction — not kept for
historical record).

Convention note: from 2026-09-15 a file that had been handed over or applied
somewhere was never edited and every change was a new numbered file. On
2026-10-02 the user explicitly asked for one merged file with the latest
tables, so that convention was set aside once; if `001_init.sql` has already
been applied on a shared database, hand the DB team the new file together
with the upgrade statements above rather than assuming it matches what they
ran. Future changes should go back to new numbered files (`002_*.sql`, ...).
