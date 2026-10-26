-- docs/admin-usage-dashboard-plan.md §4: what the agents used, for the admin dashboard (/admin/usage).
-- Numbers only, never message text. Written by the gateway (services/gateway/src/runtime/usage.ts) from the records
-- the runtimes append to <dataDir>/usage/. Adds four tables; changes none. `if not exists`: safe to run again.
-- No `json` columns and no json_* functions: lists are rows of their own table.
-- `at` is UTC; the dashboard counts days in Asia/Ho_Chi_Minh (+07:00) without needing MariaDB's tz tables.

-- One model request: a step of a turn, a compaction summary, or a call made by Data Studio's own pipeline.
create table if not exists discovery_usage_steps (
  id int auto_increment primary key,
  at datetime(3) not null,
  ms int not null,
  user_id int not null default 0,          -- discovery_users.id; 0 = unknown
  session_id varchar(64) not null,         -- discovery_sessions.session_id, or `admin-<id>` for admin jobs
  flow varchar(32) not null default '',
  project_id varchar(36) null,
  model varchar(128) not null,
  turn int not null,
  step int not null,
  purpose varchar(16) not null,            -- turn | compaction | data-studio | embedding | data-profile
  outcome varchar(32) not null,            -- ok | interrupted | error
  input_tokens int not null,
  output_tokens int not null,
  cache_read_tokens int null,
  reasoning_tokens int null,
  estimated tinyint(1) not null default 0, -- the server sent no usage
  -- one row per model call: a usage file read twice (insert ignore) never counts a call twice
  unique index usage_steps_call_idx (session_id, turn, step, purpose),
  -- every report filters on a time range
  index usage_steps_at_idx (at),
  -- one user's numbers in a time range (the drill-down)
  index usage_steps_user_id_at_idx (user_id, at)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- One turn of a chat.
create table if not exists discovery_usage_turns (
  id int auto_increment primary key,
  at datetime(3) not null,                 -- when the turn started
  ms int not null,
  user_id int not null default 0,
  session_id varchar(64) not null,
  flow varchar(32) not null default '',
  project_id varchar(36) null,
  turn int not null,
  reason varchar(32) not null,             -- completed | aborted | error | blocked | max-tokens | interrupted
  steps int not null,
  tool_calls int not null,
  tool_errors int not null,
  attachments int not null,
  unique index usage_turns_turn_idx (session_id, turn),
  index usage_turns_at_idx (at),
  index usage_turns_user_id_at_idx (user_id, at)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- Each tool a turn used: one row per (turn, tool). `at` repeats the turn's, so a report needs no join.
create table if not exists discovery_usage_turn_tools (
  id int auto_increment primary key,
  at datetime(3) not null,
  session_id varchar(64) not null,
  turn int not null,
  tool varchar(64) not null,
  calls int not null,
  errors int not null,
  unique index usage_turn_tools_idx (session_id, turn, tool),
  index usage_turn_tools_at_idx (at)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- How far the gateway has read each runtime file (`shard-<n>/<YYYY-MM-DD>.jsonl`).
create table if not exists discovery_usage_ingest (
  id int auto_increment primary key,
  file varchar(255) not null unique,
  read_offset bigint not null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;
