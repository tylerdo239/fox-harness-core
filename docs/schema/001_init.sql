-- fox-harness-core — MariaDB schema (target: MariaDB 10.11 LTS)
-- 2 tables only: users, sessions. Run on an empty database; users must be
-- created before sessions (sessions.owner_id has a foreign key to users.id).

create table if not exists users (
  id int auto_increment primary key,
  email varchar(255) not null unique,
  password_hash text not null,
  role varchar(16) not null default 'user' check (role in ('admin', 'user')),
  created_at datetime not null default current_timestamp
) engine=innodb;

-- Foreign key written as an explicit table-level `constraint ... foreign
-- key` clause, not inline column-level `references` on the column itself —
-- MySQL/MariaDB parse inline `references` but do NOT enforce it as a real
-- constraint on InnoDB. The explicit clause below is the form that actually
-- creates the constraint.
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
