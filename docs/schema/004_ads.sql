-- docs/meta-ads-mcp-plan.md §3: ad platform accounts each user connected (Meta now, TikTok later), and an audit row
-- for every write an agent asked to make on one. Adds two tables; changes none. `if not exists`: safe to run again.
-- No `json` columns. Tokens are AES-256-GCM sealed by the gateway (services/gateway/src/ads/crypto.ts); the key is
-- never in the database. Times are UTC.
-- (003 is taken by 003_memory.sql on the memory branch.)

-- One connected account per user and provider.
create table if not exists discovery_ads_connections (
  id int auto_increment primary key,
  user_id int not null,                         -- discovery_users.id
  provider varchar(16) not null,                -- meta | tiktok
  external_user_id varchar(64) null,            -- the provider's id of the person who connected
  external_name varchar(255) null,              -- shown in Settings
  scopes varchar(1024) not null default '',     -- granted scopes, space separated
  access_token_enc varbinary(4096) not null,    -- iv(12) | ciphertext | tag(16)
  refresh_token_enc varbinary(4096) null,
  key_id varchar(16) not null,                  -- which key sealed the tokens
  expires_at datetime(3) null,                  -- access token expiry; null = not told
  last_used_at datetime(3) null,
  last_error varchar(32) null,                  -- expired | revoked; cleared by the next good call
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp on update current_timestamp,
  unique index ads_connections_user_provider_idx (user_id, provider)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- One write tool call (create/update/activate...): asked, decided by the user, done. Read calls are not stored here
-- (the usage tables count them); the call's arguments stay in the session log only.
create table if not exists discovery_ads_actions (
  id int auto_increment primary key,
  user_id int not null,
  session_id varchar(64) not null,
  call_id varchar(64) not null,                 -- the tool call's id in the session log
  provider varchar(16) not null,
  tool varchar(64) not null,
  ad_account_id varchar(64) null,
  summary varchar(1000) not null,               -- what the user was asked to confirm
  spends tinyint(1) not null default 0,         -- 1 = can start spending money (activate, budget change)
  status varchar(16) not null,                  -- pending | approved | rejected | expired | done | error
  error varchar(500) null,
  asked_at datetime(3) not null,
  decided_at datetime(3) null,
  finished_at datetime(3) null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp on update current_timestamp,
  unique index ads_actions_call_idx (session_id, call_id),
  index ads_actions_user_idx (user_id, asked_at)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;
