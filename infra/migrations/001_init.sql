create table if not exists discovery_users (
  id int auto_increment primary key,
  email varchar(255) not null unique,
  password_hash varchar(161) not null,
  role varchar(16) not null default 'user' check (role in ('admin', 'user')),
  created_at datetime not null default current_timestamp
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists discovery_sessions (
  id int auto_increment primary key,
  session_id varchar(36) not null unique,
  owner_id int not null,
  created_at datetime not null default current_timestamp,
  title varchar(255),
  title_source varchar(16),
  updated_at datetime not null default current_timestamp,
  first_message_at datetime,
  flow varchar(64) not null default 'default',
  model varchar(200),
  project_id varchar(36),
  index sessions_owner_id_updated_at_idx (owner_id, updated_at desc),
  index sessions_project_id_idx (project_id)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists discovery_projects (
  id int auto_increment primary key,
  project_id varchar(36) not null unique,
  owner_id int not null,
  name varchar(120) not null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp,
  index projects_owner_id_idx (owner_id)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists discovery_custom_skills (
  id int auto_increment primary key,
  owner_id int not null,
  name varchar(64) not null,
  description varchar(280) not null,
  content_key varchar(255) not null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp,
  unique key custom_skills_owner_id_name_key (owner_id, name)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;
