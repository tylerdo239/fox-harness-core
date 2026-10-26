# Plan: admin agent-usage dashboard (`/admin/usage`) (2026-10-22)

Status: **implemented 2026-10-22** (decisions U1–U5, §8). What changed from the plan while building it (§10). Reference: `examples/pynote-be/packages/bundle-core/src/{reports,call-usage}.ts`,
`packages/llm/openai-compat/src/usage-meter.ts`, and `examples/pynote-fe/components/features/reports/reports.tsx`.

**DB change: yes, MariaDB only** — one new migration `api/migrations/002_usage.sql` that **adds** 3 tables
(§4.1). No existing table changes, nothing in Mongo, Redis keeps only a 30 s report cache.

## 1. Where we are

- Usage exists **only inside the session logs**: `assistant/message.usage` (`{inputTokens, outputTokens}`,
  `api/packages/agent-core/src/loop/agent.ts:316-324`), `tool/call`, `tool/result.isError`, `turn/end.reason`.
  The logs are zstd JSONL, archived to S3 and removed from disk after `SESSION_LOCAL_RETENTION_DAYS` (30).
- The adapter drops cache and reasoning tokens: `openai-compat/src/translate.ts:23-26, 115-119` keeps only
  `prompt_tokens` / `completion_tokens`.
- MariaDB has no usage table. `discovery_sessions` has owner, flow, model, project, created / first message /
  updated — enough for "chats per user", not for tokens.
- The runtime never talks to the DB, by design (`policy/quota.ts:6-24`).
- Admin gating is already generic: any `/admin/*` route is admin-only (`gateway/src/index.ts:1716-1733`).
- FE: `recharts` is already a dependency (`ChartView.tsx`); routing is hand-rolled (`App.tsx:128-153`); admin
  UI today is Settings > Users / Storage.

## 2. How pynote does it, and what we take

pynote builds the report **on request by scanning every session log** (cached 15 s, per-session stats cached in
memory) plus one JSONL/Mongo record per LLM call. That works for one org on one disk. Here it does not:
logs older than 30 days are only on S3 (a 90-day report would download thousands of objects), and 1k–10k
sessions per peak makes a full scan per request too slow.

Taken from pynote: the record shape (per LLM call: latency, purpose, outcome, in / out / cache / reasoning
tokens), the report shape (totals + previous period + series + per user / model / tool + outcomes), the screen
(period filter, KPI cards with delta, bar series, outcomes, member table, CSV), "numbers only, never message
text", `Asia/Ho_Chi_Minh` days.

Changed: records are **written once when they happen and kept in MariaDB**, so a report is a few `GROUP BY`
queries.

## 3. Capture (runtime)

### 3.1 Records
Written by agent-core's loop (`loop/agent.ts`) — it is our code, so no session-log parsing:

`step` — one per LLM request, written right after `assistant/message` (and for a failed / aborted request):
```
{ kind:'step', t, ms, userId, sessionId, flow, projectId?, model, turn, step,
  purpose:'turn'|'compaction'|'title', outcome:'ok'|'error'|'aborted'|'length'|…,
  in, out, cacheRead?, reasoning?, estimated }
```
`turn` — one per `turn/end`:
```
{ kind:'turn', t (start), ms, userId, sessionId, flow, projectId?, turn, reason, steps,
  tools:{<name>:count}, toolErrors, attachments }
```
Compaction (`fox-harness-compaction`) and session titles also call the model: they get `purpose` so the report
can show overhead separately.

### 3.2 Transport: local file → gateway → MariaDB
- The runtime appends to `<dataDir>/usage/<shard>/<YYYY-MM-DD>.jsonl` (no DB, no network; a failed write is
  logged and never breaks a turn).
- The gateway sweep (next to the session-archive sweep, every 60 s) reads new bytes from each file and inserts
  in batches; its position per file is kept in `discovery_usage_ingest(file, offset)`. Inserts are idempotent
  (unique keys below), so a crash between insert and offset update only re-inserts duplicates that are ignored.
- Files older than 7 days and fully ingested are deleted.

### 3.3 Token fix
`translate.ts`: map `usage.prompt_tokens_details.cached_tokens` → `cacheReadTokens` and
`completion_tokens_details.reasoning_tokens` → `reasoningTokens` (dsh `TokenUsage` already has the fields).

### 3.4 Data Studio pipeline tokens (U5: in scope)
`analyze_data` runs a Python pipeline (`api/packages/tool/data-studio-agent/python`, agno ≥ 2.9) that calls the
LLM itself, outside the dsh loop. agno reports `metrics` (input / output / cache read / reasoning tokens,
duration) on every run, the final event of a streamed run included.
- Collect them in one place per pipeline: the two agent base classes — `src/pipeline_v3/base.py`
  (`arun` at 103, 128, 151) and `src/pipeline_v4/agents/base.py` (122, 152, 277) — add each run's metrics to a
  per-request accumulator (a `contextvars` list: one entry per run: agent name, model, in, out, cache, reasoning,
  ms, ok / error). Agents that call `arun` elsewhere (`keywords.py`, `decompose.py`, `retrieval.py`) go through
  these classes; check each with a test.
- Embeddings (`src/services/embedding_client.py`): add the response's `usage.total_tokens` as an entry with
  `purpose:'embedding'`.
- `bridge/runner.py` puts the list in its reply (`usage: [...]`, next to the answer); the TS tool
  (`data-studio-agent/src/index.ts`) passes it on in the tool result `meta`; the loop writes one `step` record per
  entry with `purpose:'data-studio'` (or `'embedding'`), the same `turn`, and `step` numbered after the turn's own
  steps — so no new table.
- The admin "data profile" build (`bridge/admin_runner.py`, `src/data_profile/suggest.py`) also calls the LLM
  outside any chat: record it the same way with `purpose:'data-profile'`, the admin's user id and no session
  (`session_id` = the job id).
- An aborted / timed-out pipeline still reports what it used so far (the accumulator is read in a `finally`).

## 4. Storage

### 4.1 Migration `002_usage.sql`
```sql
create table discovery_usage_steps (
  id bigint auto_increment primary key,
  at datetime(3) not null, ms int not null,
  user_id int not null, session_id char(36) not null, flow varchar(32) not null, project_id varchar(64) null,
  model varchar(128) not null, turn int not null, step int not null,
  purpose varchar(16) not null, -- turn | compaction | title | data-studio | embedding | data-profile
  outcome varchar(32) not null,
  input_tokens int not null, output_tokens int not null, cache_read_tokens int null, reasoning_tokens int null,
  estimated tinyint(1) not null default 0,
  unique key (session_id, turn, step, purpose),
  key (at), key (user_id, at)
);
create table discovery_usage_turns (
  id bigint auto_increment primary key,
  at datetime(3) not null, ms int not null,
  user_id int not null, session_id char(36) not null, flow varchar(32) not null, project_id varchar(64) null,
  turn int not null, reason varchar(32) not null, steps int not null, tool_errors int not null,
  attachments int not null,
  unique key (session_id, turn),
  key (at), key (user_id, at)
);
create table discovery_usage_turn_tools (
  id int auto_increment primary key,
  at datetime(3) not null, session_id varchar(64) not null, turn int not null,
  tool varchar(64) not null, calls int not null, errors int not null,
  unique key (session_id, turn, tool), key (at)
);
create table discovery_usage_ingest (file varchar(255) primary key, offset bigint not null, updated_at datetime not null);
```
Size: ~150 B / step row; 10k sessions × 10 turns × 3 steps = 300k rows ≈ 50 MB / month. Fine.

Retention: `USAGE_RETENTION_DAYS` (default 400) — the daily cleanup deletes older rows.

Per-tool counts: one row per turn and tool in `discovery_usage_turn_tools` (2026-10-26: no `json` columns and no
`json_*` functions in the schema; the first version kept a `tools json` column read with `JSON_TABLE`).

### 4.2 Backfill (optional, one-off)
`api/scripts/usage-backfill.mjs`: read local + S3 session logs, emit the same records (owner from
`discovery_sessions`). Without it the dashboard starts at the deploy date.

## 5. API (gateway, admin-only by the existing `/admin/` rule)

`GET /admin/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|week|month` (or `days=N`, default 30; max 366 days;
`to` clamped to today; days in `REPORT_TIME_ZONE`, default `Asia/Ho_Chi_Minh`, as a fixed `+07:00` offset so
MariaDB needs no tz tables):
```jsonc
{
  "range": { "from","to","days","group","timeZone","previousFrom","previousTo" },
  "totals": Totals, "previous": Totals,
  "series": [ Totals & { "key","from","to" } ],
  "hours": number[24], "weekdays": number[7],
  "outcomes": { "completed","cancelled","failed","blocked", "kinds":[{"kind","count"}] },
  "users":  [ Totals & { "id","email","role","lastActiveAt" } ],
  "models": [{ "model","input","output","calls" }],
  "flows":  [{ "flow","turns","tokens" }],
  "tools":  [{ "tool","calls","errors" }],
  "dataStudio": { "turns","inputTokens","outputTokens","embeddingTokens","profileTokens" },
  "overhead": { "compactionTokens","titleTokens","failedCalls","cacheShare"|null }
}
// Totals = { activeUsers, chats, turns, completedTurns, cancelledTurns, failedTurns,
//            inputTokens, outputTokens, cacheReadTokens, toolCalls, toolErrors, avgTurnMs, medianTurnMs }
// tokens include the Data Studio pipeline (purpose data-studio / embedding / data-profile)
```
`GET /admin/usage/users/:id?from&to` — one user's chats in the period (title, flow, turns, tokens, last active),
newest first, 100 per page (`cursor`).

Cache: one result per `(from,to,group)` for 30 s (Redis). Log a warning above 1.5 s.

No cost / pricing (U3): the dashboard measures tokens.

## 6. FE route `/admin/usage`

Routing — the three places, or a reload 404s (the 2026-10-19 `/data-studio` bug):
1. `App.tsx` route parser + `pushState` helper.
2. `app/nginx.conf.template`: add `/admin/usage` to the SPA exception before the API regex
   (`/admin/` is an API prefix!) — e.g. `location ~ ^/(data-studio(/chat/[^/]+)?|admin/usage)/?$`.
3. `app/scripts/serve.mjs` reads `SPA_PATHS` from that block — check it parses the new alternative.

Entry: AccountMenu item "Usage" (admins only) + Settings > Users links to it. A non-admin opening the URL is
sent to `/` (the API answers 403 regardless).

Screen (`app/src/components/features/admin/UsageDashboard.tsx`, recharts, theme tokens, orange brand):
1. Header + `PeriodFilter`: 7 / 30 / 90 days, this month, last month, custom from–to, group day/week/month.
2. KPI cards with ± vs previous period: active users, chats, turns, tokens (in · out · cache), avg / median
   response time, success rate, tool calls (errors).
3. Series: tokens (stacked in / out), turns, active users, response time.
4. Hour-of-day and weekday bars.
5. Outcomes: completed / stopped / failed / blocked (budget) + failure kinds.
6. By user table: sortable, CSV export; click → drill-down drawer (`/admin/usage/users/:id`).
7. By model, by flow (default / data-analysis / data-studio), top tools with error rate.
8. Data Studio: turns, pipeline tokens (in / out), embedding tokens, data-profile tokens.
9. Overhead: compaction + title tokens, failed calls, cache share.
States: skeleton on first load, previous data dimmed while a new period loads, inline error, empty "No usage in
this period". Refresh every 60 s while visible. i18n vi / en (`dashboard.usage.*`).

## 7. Tests
- e2e (`scripts/e2e-backend.mjs`): mock LLM returns a usage chunk → after a turn and one sweep the row is in
  MariaDB; `/admin/usage` totals match; a user gets 403; a crash before the offset update does not double count;
  `GET /admin/usage` page reload returns the SPA (200, HTML), `GET /admin/usage` with `Accept: json` via the API
  path still works.
- Data Studio: a mocked pipeline reply with `usage: [...]` → `purpose:'data-studio'` rows on the same turn;
  python test that the v3 / v4 base classes add every run (streamed and not) to the accumulator, also on error.
- Unit: day bucketing at the `+07:00` boundary, week starts Monday, previous-period math, median.
- FE: headless harness page with a mock report (as for Data Sources), screenshots light / dark, phone width.

## 8. Decisions (taken 2026-10-22)

| # | Question | Decision |
|---|---|---|
| U1 | Backfill old sessions? | no at first; script later if wanted |
| U2 | Retention | 400 days |
| U3 | Show cost? | no |
| U4 | Where | its own route `/admin/usage` |
| U5 | Data Studio pipeline tokens | yes, in this work (§3.4) |

## 9. Order and size
1. Token fix + capture + JSONL (runtime) — 1 day.
1b. Data Studio pipeline usage (python accumulator, bridge, tool meta) — 1 day.
2. Migration + sweep ingest + retention — 1 day.
3. `/admin/usage` API + drill-down — 1–1.5 days.
4. FE route + screen — 2 days.
5. e2e + harness screenshots — 1 day.

## 10. As built (2026-10-22)

| Part | Where |
|---|---|
| Records | `api/packages/agent-core/src/transport/usage-recorder.ts` — listens to `session/event` (one listener for the process) instead of editing the loop: `turn/start`, `step/start`, `assistant/message` (usage, model), `tool/call` / `tool/result` (per-tool calls and errors), `compaction/summary` (usage), `turn/end`, and `fox/usage` |
| Token fix | `api/packages/llm/openai-compat/src/translate.ts` (`cached_tokens` / `prompt_cache_hit_tokens`, `reasoning_tokens`) |
| Data Studio | `python/src/usage_meter.py` wraps the openai SDK's `chat.completions.create` / `embeddings.create` once (agno, the data profile's sync client and the embeddings all go through it); `bridge/runner.py` returns `usage` with every reply, failed ones included; the tool appends a `fox/usage` session event (registered type, so old chats still resume). Admin jobs (`bridge/admin_runner.py`: data profile, sync, reindex) are recorded by the gateway (`data-studio-bridge.ts` → `recordAdminUsage`) under the admin who asked |
| Storage | `api/migrations/002_usage.sql` (`discovery_usage_steps`, `discovery_usage_turns` with `tool_calls`, `discovery_usage_turn_tools` per tool, `discovery_usage_ingest.read_offset`) |
| Ingest / report | `api/services/gateway/src/runtime/usage.ts` (owner / flow / project joined from `discovery_sessions` at ingest) |
| API | `GET /admin/usage/report`, `GET /admin/usage/users/:id` — **not** `/admin/usage`, which is the page (nginx SPA exception) |
| Page | `app/src/components/features/admin/UsageDashboard.tsx`, `usageApi.ts`; route in `App.tsx`; account-menu entry (admins) |
| Tests | e2e `usageDashboard` (`scripts/e2e-backend.mjs`); headless screenshots light / dark / phone |

Differences from the plan:
- Report cache in the gateway's memory (one gateway process), `USAGE_REPORT_CACHE_MS`, not Redis.
- Session titles are not counted: dsh's title plugin calls the model without recording usage anywhere.
- A subagent's turns are recorded under its own session id; its owner comes from the agent options when it has
  no `discovery_sessions` row (else user 0, "unknown").
