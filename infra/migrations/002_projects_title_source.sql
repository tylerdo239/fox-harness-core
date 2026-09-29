-- 002 (2026-09-15): projects and title sources. Run after 001_init.sql, on a
-- database created from it. Every statement is `if not exists`, so running
-- this file again, or on a database that already has these changes, changes
-- nothing.

-- `sessions.title_source`: where `title` came from — 'user' (a sidebar
-- rename), 'fallback' (first words of the first message) or 'provider' (the
-- model's title); an automatic title never replaces a user rename
-- (services/gateway/src/db.ts renameSession).
-- `sessions.project_id` (docs/rlm-transfer-plan.md 9.1): the project a
-- data-analysis chat belongs to (`projects.project_id`), null for a chat
-- outside any project.
alter table sessions add column if not exists title_source varchar(16) after title;
alter table sessions add column if not exists project_id varchar(36) after flow;
create index if not exists sessions_project_id_idx on sessions (project_id);

-- Projects (docs/rlm-transfer-plan.md 9.1): a named shared data folder for a
-- user's data-analysis chats. `project_id` is a UUID for the same reason as
-- `sessions.session_id` (URLs, on-disk folder name `data/projects/<project_id>`),
-- `id` a surrogate int primary key. `sessions.project_id` has no foreign key:
-- deleting a project purges its chats through services/gateway first (their
-- data lives outside the DB).
create table if not exists projects (
  id int auto_increment primary key,
  project_id varchar(36) not null unique,
  owner_id int not null,
  name varchar(120) not null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp,
  constraint projects_owner_id_fkey foreign key (owner_id) references users (id) on delete cascade
) engine=innodb;
