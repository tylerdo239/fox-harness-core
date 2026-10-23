-- docs/memory-plugin-plan.md §5.1: long-term memory (services/gateway/src/memory/). MariaDB is the source of truth;
-- the vectors live on Qdrant (collections memory_events / memory_entities / memory_keywords, same ids).
-- Adds five tables; changes none. `if not exists`: safe to run again.

-- One memory: a fact, decision, task, goal, profile or preference said in a chat, or a period summary.
create table if not exists discovery_memory_events (
  id int auto_increment primary key,
  event_id char(36) not null unique,
  user_id int not null,
  session_id varchar(64) not null default '',
  scope varchar(8) not null,
  type varchar(32) not null,
  content varchar(1000) not null,
  props json not null,
  importance float not null default 0.5,
  topic varchar(200) not null default '',
  ranges varchar(200) not null default '',
  source text not null,
  keywords json not null,
  level tinyint not null default 0,
  compressed_into char(36) null,
  hits int not null default 0,
  last_access datetime(3) null,
  expires_at datetime(3) null,
  created_at datetime(3) not null,
  index memory_events_owner_idx (user_id, session_id, scope),
  index memory_events_timeline_idx (user_id, session_id, topic, created_at),
  index memory_events_expires_idx (expires_at)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- The current state the events add up to (newest value of a fact, a decision per topic, the chat's brief, ...).
create table if not exists discovery_memory_entities (
  id int auto_increment primary key,
  entity_id char(36) not null unique,
  schema_name varchar(32) not null,
  scope varchar(8) not null,
  user_id int not null,
  session_id varchar(64) not null default '',
  entity_key varchar(200) not null default '',
  state json not null,
  aux json not null,
  text varchar(2000) not null default '',
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  unique index memory_entities_key_idx (schema_name, user_id, session_id, entity_key),
  index memory_entities_owner_idx (user_id, session_id)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- Every value an entity property took, for "(trước: ...)", edits, forgetting and merging.
create table if not exists discovery_memory_entity_history (
  id int auto_increment primary key,
  entity_id char(36) not null,
  prop varchar(64) not null,
  op varchar(16) not null,
  value text not null,
  event_id char(36) not null default '',
  source_session varchar(64) not null default '',
  at datetime(3) not null,
  index memory_history_entity_idx (entity_id, id),
  index memory_history_session_idx (source_session)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- The keyword graph: which events carry a keyword (its vector is on Qdrant, memory_keywords).
create table if not exists discovery_memory_keyword_links (
  id int auto_increment primary key,
  user_id int not null,
  keyword varchar(100) not null,
  event_id char(36) not null,
  unique index memory_keyword_links_idx (user_id, keyword, event_id),
  index memory_keyword_links_event_idx (event_id)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- On/off switches: 'org', 'user:<id>', 'session:<id>'. No row = the default.
create table if not exists discovery_memory_settings (
  id int auto_increment primary key,
  owner varchar(80) not null unique,
  enabled tinyint(1) not null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;
