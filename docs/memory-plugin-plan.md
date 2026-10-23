# Plan: long-term memory as a dsh plugin, on MariaDB + Qdrant (2026-10-23)

Status: **implemented 2026-10-23** on branch `feat/memory` (as built: §13). Port of examples/pynote-be's memory (`docs/pynote-memory-reference.md`) into
fox-harness. Decisions taken 2026-10-23:
- **Architecture: plugin + gateway.** The dsh plugin in the runtime only does the hooks. All logic, MariaDB and Qdrant
  live in the gateway. The runtime keeps holding no DB credential (`policy/quota.ts`, `runtime/supervisor.ts`: "DATABASE_URL… never reach it").
- **Scope: full port**, lifecycle included: TIME_COMPRESS, expiry with reinforcement, merging keys that mean the same
  thing, and the keyword graph.
- **Infrastructure the company gives: MariaDB and Qdrant only.** Nothing on local files, since the pods have no shared disk.

**DB change: yes.**
- MariaDB: new migration `003_memory.sql`, adding 5 tables and changing none.
- Qdrant: 3 new collections.

## 1. What the user gets

- **The agent remembers:**
  - **within a chat:** the current facts and numbers (newest value, with what it replaced), decisions, open tasks and
    the chat's goal;
  - **across chats:** the member's role and lasting conventions ("from now on, amounts in millions").
- **Each turn starts with a "Memory" block** of at most ~1.600 tokens, ranked for the request.
- **No leaks between chats:** a figure from one project never shows up in another chat. Scope is decided by the schema
  plus a guard in code, not by the model.
- **Settings → Memory:** see every memory, edit one, delete one, delete everything.
  - **Chat header:** turn memory off for this chat.
  - **Admin:** turn memory off for the whole organization.
- **Deleting a chat** deletes that chat's memories. What the user said should hold everywhere is kept.
- **Costs** (extraction, embedding, compression) show on `/admin/usage` with `purpose: memory-*`.

## 2. Architecture

```
 runtime (dsh, per shard)                         gateway                                     company infra
┌────────────────────────────────┐  HTTP + secret  ┌─────────────────────────────────────┐
│ @fox-harness/dsh-memory        │ ──────────────▶ │ services/gateway/src/memory/        │ ──▶ MariaDB (003_memory.sql)
│  agent/pre-step (step 1):      │  POST /internal │  api.ts      internal + user routes │ ──▶ Qdrant (3 collections)
│    recall → plugin message     │  /memory/recall │  extract.ts  1 LLM call / turn      │ ──▶ LLM (OPENAI_*), embeddings
│  session/event turn/end:       │  /memory/remember│  store.ts    MariaDB (events,       │      (EMBEDDING_*)
│    remember (fire and forget)  │                 │              entities, history…)    │
│  4 s budget, never blocks turn │ ◀────────────── │  vectors.ts  Qdrant dense + sparse  │
└────────────────────────────────┘  {text}         │  retrieve.ts rank.ts lifecycle.ts   │
                                                   │  queue.ts    one queue per user     │
                                                   │  sweep       maintain every 6 h     │
                                                   └─────────────────────────────────────┘
```

**Why a gateway service and not a Python child like pynote:**
- The gateway already holds MariaDB, the LLM and embedding settings, the usage tables and the delete hooks.
- A port to TypeScript (about 2.000 lines) removes a long-lived Python process and its single-process store lock. The
  lock was only there for SQLite and the embedded Qdrant.
- The prompts, operators, ranking and lifecycle are ported as they are, with the same constants (§6–§8), so pynote's
  benchmarks still say something about this code.

## 3. Runtime plugin: `api/packages/memory` (`@fox-harness/dsh-memory`)

A cordis plugin added to the profile bundles. It is global: every flow except `data-studio` uses it.

**Recall at the start of a turn** (`agent/pre-step`, `payload.step === 1`, the same seam `flow-data-analysis` uses for
dataset cards):
1. **Skip when:**
   - the flow is `data-studio` (it answers from company data, not from chat);
   - the agent is a subagent (`session.header.parentSession` is set);
   - there is no `userId` in the agent options.
2. **Query:** the last human message. A short follow-up (under 40 characters, e.g. "tiếp tục") also takes the message
   before it. Capped at 1.000 characters.
3. **Call:** `POST {FOX_GATEWAY_URL}/internal/memory/recall {userId, sessionId, query}`, header
   `x-fox-harness-internal-secret`, with `Promise.race` against **4 s**. A timeout or any error means the turn runs
   without memory and a log line is written.
4. **Insert:** add the answer as a user message with `source: {kind: 'plugin', plugin: 'fox-harness-memory'}`, so it is
   a session event and stays reconstructable from the log.
   - Not re-sent when the text is the same as the last one for this chat (kept in a `Map` per process).
   - The text ends with "Do not recite memory to the user; they see and delete it in Settings → Memory".
5. **FE:** `Conversation.tsx` hides `source.kind === 'plugin'` messages, like the dataset cards. Check that it does.

**Remember at the end of a turn** (`ctx.on('session/event')` `turn/end`, same pattern as `usage-recorder.ts`):
- Same skip rules, plus: the turn must have ended `completed`.
- Collect the turn's human messages and the final assistant text, each capped at 3.000 characters.
- Send `POST /internal/memory/remember {userId, sessionId, flow, projectId?, messages, at}` and do not await it. The
  gateway answers 202 and queues the work.

**Config from the supervisor:**
- `FOX_GATEWAY_URL`, e.g. `http://127.0.0.1:4000`. New: today only gateway → runtime calls exist; this is the reverse
  direction.
- `FOX_INTERNAL_SECRET`, which already exists.
- The plugin is off when `MEMORY` (gateway env) is `0`: the supervisor then does not set `FOX_GATEWAY_URL`.

**Prompt section:** none. The model only sees the memory block. Recall is not exposed as a tool for the model to call
(pynote does not do that either). It could come later.

## 4. Gateway: `services/gateway/src/memory/`

### 4.1 Internal routes (runtime → gateway)

| Route | Body | Answer | Notes |
|---|---|---|---|
| `POST /internal/memory/recall` | `{userId, sessionId, query}` | `{text, tokens}` | Answer within the 4 s budget. Embedding the query is the only network call; no LLM unless rerank is `llm` |
| `POST /internal/memory/remember` | `{userId, sessionId, flow, projectId?, messages, at}` | `202` | Queued per user (§4.4) |

- **Guard:** `x-fox-harness-internal-secret` must equal the supervisor's secret, and the request must come from
  loopback. These routes are **not** proxied by nginx: `/internal/` is missing from the API regex, so they are
  unreachable from outside, and the gateway also refuses a non-loopback source.
- **Owner check:**
  - `sessionId` must belong to `userId` in `discovery_sessions`.
  - The memory switches must be on: the organization's, the user's own, and the chat's.

### 4.2 User routes (Settings → Memory, chat header)

| Route | Who | What |
|---|---|---|
| `GET /memory` | the user | every memory (one line per entity): `{id, layer: user\|chat, sessionId?, chatTitle?, text, updatedAt}` + `{enabled, orgEnabled, ready}` |
| `PATCH /memory/:id {text}` | owner | edit: the text becomes the current value (history kept); events that fed the old value are deleted |
| `DELETE /memory/:id` | owner | forget one memory and the events that fed it |
| `POST /memory/clear {layer?, sessionId?}` | owner | clear a layer, one chat's memories, or everything |
| `GET/PUT /sessions/:id/memory {enabled}` | chat owner | per-chat switch |
| `PUT /admin/memory {enabled}` | admin | organization switch (reuses the settings table, see §5) |

### 4.3 Delete hooks

| When | What |
|---|---|
| Chat purge (`DELETE /sessions/:id`, `purgeSessionData`) | `clear(user, layer: chat, sessionId)`: MariaDB rows and Qdrant points filtered by `session_id` |
| Project delete (`deleteProjectData`) | the same for each of the project's chats |
| Settings → Storage "clear" | nothing: memory is not file storage |
| User deleted (if ever added) | `clear(user)` |

### 4.4 Work queue and concurrency

- **One promise queue per user** (like pynote's core), so one member's writes apply in order.
  - Members run in parallel, capped by `MEMORY_CONCURRENCY` (default 4) so extraction does not take all of the LLM.
- **Recall never waits for the queue.** It reads what is committed. Writes use transactions (MariaDB) and upserts by id
  (Qdrant), so there is no store-wide lock.
- **Several gateway replicas** (not today): the queue would have to move to Redis. Noted, not built.
- **Failure handling:**
  - A failed extraction is retried once.
  - If it fails again, the turn is skipped and logged (`memory_extract_failed`). It is never retried forever.
  - Usage is recorded either way.

## 5. Storage

### 5.1 MariaDB: `api/migrations/003_memory.sql`

Same conventions as `001` / `002`: `discovery_` prefix, `id int`, `utf8mb4`, `if not exists`.

```sql
create table if not exists discovery_memory_events (
  id int auto_increment primary key,
  event_id char(36) not null unique,          -- also the Qdrant point id
  user_id int not null,
  session_id varchar(64) not null default '', -- '' for scope user
  scope varchar(8) not null,                  -- user | session
  type varchar(32) not null,                  -- fact | decision | task | goal | profile | preference | summary
  content varchar(1000) not null,
  props json not null,
  importance float not null default 0.5,
  topic varchar(200) not null default '',
  ranges varchar(200) not null default '',
  source text not null,                       -- the conversation excerpt it came from (<= 1500 chars)
  keywords json not null,
  level tinyint not null default 0,           -- 0 detail, 1 period summary
  compressed_into char(36) null,
  hits int not null default 0,
  last_access datetime null,
  expires_at datetime null,
  created_at datetime(3) not null,
  index memory_events_owner_idx (user_id, session_id, scope),
  index memory_events_timeline_idx (user_id, session_id, topic, created_at),
  index memory_events_expires_idx (expires_at)
);
create table if not exists discovery_memory_entities (
  id int auto_increment primary key,
  entity_id char(36) not null unique,         -- also the Qdrant point id
  schema_name varchar(32) not null,           -- ChatFact | ChatDecision | ChatTask | ChatBrief | UserProfile | UserPreference
  scope varchar(8) not null,
  user_id int not null,
  session_id varchar(64) not null default '',
  entity_key varchar(200) not null default '', -- folded key ('' for single entities like ChatBrief)
  state json not null,                         -- {prop: value, _label: "as written"}
  aux json not null,                           -- operator side state (AVG counts…)
  text varchar(2000) not null default '',      -- what was embedded
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  unique index memory_entities_key_idx (schema_name, user_id, session_id, entity_key),
  index memory_entities_owner_idx (user_id, session_id)
);
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
);
create table if not exists discovery_memory_keyword_links (
  id int auto_increment primary key,
  user_id int not null,
  keyword varchar(100) not null,               -- folded
  event_id char(36) not null,
  unique index memory_keyword_links_idx (user_id, keyword, event_id),
  index memory_keyword_links_event_idx (event_id)
);
create table if not exists discovery_memory_settings (
  id int auto_increment primary key,
  owner varchar(80) not null unique,           -- 'org' | 'user:<id>' | 'session:<id>'
  enabled tinyint(1) not null,
  updated_at datetime not null default current_timestamp
);
```

- No foreign keys, as in `001`. Ownership is enforced in code.
- `entity_history` rows are deleted with their entity in the same transaction.
- **Sizing:** at most about 10 events per turn. 10k chats × 10 turns × 3 events = 300k event rows a month, plus far
  fewer entity rows.

### 5.2 Qdrant (server)

| Collection | Points | Vectors | Payload (indexed) |
|---|---|---|---|
| `memory_events` | one per event (id = `event_id`) | `dense` (embedding model dims, cosine) + `sparse` (folded terms, `modifier: idf`) | `user_id`, `session_id`, `scope`, `type`, `level`, `expires_at` |
| `memory_entities` | one per entity (id = `entity_id`) | `dense` | `user_id`, `session_id`, `scope`, `schema` |
| `memory_keywords` | one per (user, keyword) (id = uuid5 of both) | `dense`: mean of the vectors of the events carrying it, with count `n` in the payload | `user_id`, `keyword` |

- **Sparse vectors instead of MariaDB FULLTEXT:** InnoDB FULLTEXT drops words shorter than `innodb_ft_min_token_size`
  (default 3), and many Vietnamese syllables have 2 characters. Changing that is a server setting the company DB may
  not allow.
  - Terms are folded (lower case, no diacritics, as pynote's `fold`) and hashed into the sparse index space.
  - Qdrant ≥ **1.10** applies IDF, so scores are BM25-like.
  - **Needs confirming:** the version of the company's Qdrant. Fallback: a folded-text column in MariaDB searched with
    `LIKE`, with no BM25 score.
- **Hybrid in one query:** the Query API prefetches `dense` (top 20) and `sparse` (top 20) under the same filter. Scores
  are normalised in code as pynote does (dense min–max, sparse ÷ max) and mixed `0.6·dense + 0.4·sparse`. Qdrant's own
  RRF fusion is not used, because it would change the ranking pynote was measured with.
- **Every query filters on `user_id`.** A missing filter must be impossible: the vector module takes `userId` as a
  required argument and builds the filter itself.
- **Created on first use** (`createCollection` if missing, with payload indexes), dims taken from the embedding model.
- **Consistency:** MariaDB is the source of truth.
  - On write: MariaDB first (transaction), then Qdrant upsert. A failed upsert is retried and, if it still fails,
    recorded for the 6-hourly sweep to repair.
  - The sweep also re-indexes rows with no point.
  - Deletes go to both stores (filter by ids).

### 5.3 Config (gateway env, `api/.env.example`)

| Env | Default | |
|---|---|---|
| `MEMORY` | `1` | `0` = off everywhere (plugin not started) |
| `QDRANT_URL`, `QDRANT_API_KEY` | — | required when `MEMORY=1` |
| `MEMORY_COLLECTION_PREFIX` | `fox_` | so staging and prod can share a Qdrant |
| `MEMORY_LLM_MODEL` | `OPENAI_MODEL_ID` | extraction model; same OpenAI-compatible server |
| `MEMORY_LLM_EXTRA_BODY` | `OPENAI_EXTRA_BODY` | e.g. thinking off |
| `MEMORY_EMBED_*` | `EMBEDDING_*` | Data Studio's embedding server; e5 prefixes when the model name has "e5" |
| `MEMORY_RERANK` | `none` | `none` \| `llm` \| `http` (+ `_BASE_URL`, `_MODEL`) |
| `MEMORY_LANGUAGE` | `vi` | `vi` \| `en` \| `auto` |
| `MEMORY_MAX_TOKENS` | `1600` | memory block budget |
| `MEMORY_RECALL_TIMEOUT_MS` | `4000` | longest a turn waits for its memory block (plugin side) |
| `MEMORY_CONCURRENCY` | `4` | members extracted in parallel |
| `MEMORY_MAINTAIN_HOURS` | `6` | lifecycle per member at most this often |

Docker: add a `qdrant/qdrant` service to `docker-compose.yml` (local) and `scripts/e2e-up.sh`. In production it is
the company's server.

## 6. Logic ported from pynote (same rules and constants)

Source files are in `examples/pynote-be/libs/pynote-memory/pynote_memory/`.

| pynote | fox-harness (`memory/`) | Notes |
|---|---|---|
| `schemas/pynote.yaml`, `schema.py` | `schema.yaml` + `schema.ts` | same 6 event types and 6 entities. The `instructions` text is reworded for fox-harness ("Trợ lý" = Fox Harness agent) |
| `extractor.py` | `extract.ts` | one call does filter, topic segments (`ranges`), events, patches and forget. Fixed part first for prefix cache. Output validated, scope guard (`preference` needs a lasting cue and no "this chat only"; `profile` without numbers, else demoted to `decision`). A broken JSON halves the batch and retries |
| `operators.py`, `patch.py` | `operators.ts`, `patch.ts` | SET, IMMUTABLE, SUM, COUNT, MAX, MIN, AVG, APPEND, LLM_MERGE; number parsing vi/en; SEARCH/REPLACE patch: exact and unique, else folded fuzzy match ≥ 0.8 |
| `memory.py` `apply` | `ingest.ts` | prefetch (chat singles + top 12 entities by vector) → extract → dedup (same key and value = duplicate; same key, new value = update; no key: cosine ≥ 0.97 duplicate, 0.85–0.97 one LLM call for the turn) → store events → operators → patches (LLM_MERGE fallback, shorten above 1.200 characters) → forget → re-embed touched entities |
| `retriever.py`, `ranking.py`, `rerank.py` | `retrieve.ts`, `rank.ts`, `rerank.ts` | primary hybrid (quota 8) + keyword graph (cosine ≥ 0.8, quota 3) + optional rerank (blend 0.5) + reinforcement (`hits`, `last_access`). `final = 0.65·origin + 0.2·time + 0.15·busi`, time fresh 1 day then half-life 30 days, busi = type weight × importance, min 0.25 |
| `memory.py` `context` | `context.ts` | user entities (≤ 12, by relevance), chat singles + keyed (≤ 30), events; 70% of the budget for entities, the rest for events not already represented; dates and "(trước: …)" from history |
| `lifecycle.py` | `lifecycle.ts` | TIME_COMPRESS (timeline = scope, chat, topic; idle 3 days, older than 7, at least 3 events, one summary per week; details get TTL 30 days), expiry postponed when retrieved within 14 days, LLM_MERGE, LLM dedup, merging keys that mean the same thing (≤ 100 per type) |
| `memory.py` `memories` / `edit` / `forget` / `clear` | `manage.ts` | as pynote; `clear(session)` keeps user-scope entries said in that chat |
| `entity_store.forget_session` (replay) | `manage.ts` | not used by the routes (as in pynote's core); kept for a future "forget everything this chat taught" |

**Differences on purpose:**
- **Merging keys runs for chat entities too.** It is called per chat with recent activity, during the 6-hourly
  maintenance. In pynote only the user layer was merged, because the server called `consolidate` without a session.
- **The keyword graph lives on Qdrant** instead of BLOB rows with cosine in numpy, so it scales past a few hundred
  keywords per user.
- **Data Studio chats are excluded.** Their answers come from company data, and remembering figures from them would go
  stale.

## 7. Usage and logs

- **Every LLM and embedding call goes into `discovery_usage_steps`**, through the same insert path as admin jobs
  (`recordAdminUsage`, generalised):
  - `session_id` = the chat, `turn` = the turn, `step` ≥ 3000;
  - `purpose`: `memory-extract`, `memory-dedup`, `memory-merge`, `memory-compress`, `memory-keys`, `memory-embed`,
    `memory-rerank`;
  - `flow` = the chat's flow;
  - `user_id` = the owner.
  - The dashboard shows them in "Overhead": a "Memory" tile and a by-purpose list.
- **Logs:**
  - `memory_recall` with ms, tokens, entity and event counts;
  - `memory_remember` with events added, duplicates, demoted, patches, forgotten and ms;
  - `memory_maintain`;
  - `memory_extract_failed`.
  - Never message text.

## 8. FE

- **Settings → new "Bộ nhớ" tab:**
  - The list, grouped "About you (every chat)" and "Per chat" (with the chat's title as a link).
  - Edit and delete on each row, "Delete all" with a confirmation.
  - The user's own on/off switch.
  - When the organization switch is off: a notice and the list read-only.
- **Chat header menu:** "Bộ nhớ cho cuộc chat này" on/off.
- **Admin:** the organization switch in Settings → Users (or in the usage dashboard).
- **Conversation:** plugin messages stay hidden. A small "Đã dùng bộ nhớ" chip on the turn (count of entities and
  events, no content) helps trust; optional.
- i18n vi/en.

## 9. Tests

- **Unit, ported from pynote's offline tests** (`tests/test_core.py`, `test_paper.py`, `test_product.py`, 45 tests)
  with a fake LLM and a fake embedder:
  - operators;
  - patch matching;
  - scope guard;
  - dedup thresholds;
  - "(trước: …)" lines;
  - budget cut;
  - compression plan;
  - expiry with reinforcement.
- **e2e** (`scripts/e2e-backend.mjs`, Qdrant container added; the mock LLM answers the extraction prompt with fixed
  JSON):
  - a turn with "ngân sách 800 triệu", then "sửa lại 500 triệu" → the next turn's memory block shows 500 with
    "(trước: 800…)";
  - a project figure never shows in another chat of the same user (leak test);
  - "từ nay dùng đơn vị triệu" → shows in a new chat; "chỉ chat này thôi" → does not;
  - forget on request; edit and delete through the routes;
  - chat purge removes its rows and points;
  - the chat switch and the organization switch;
  - another user cannot list, edit or delete (404);
  - `/internal/memory/*` is unreachable through nginx and refused without the secret;
  - recall answers within 4 s while an extraction is running;
  - restart: memory still there (MariaDB + Qdrant, nothing on local disk);
  - usage rows with `purpose: memory-*`.
- **Bench:** port `bench/uav.py` (Vietnamese UAV scenario, scored in code) and run it against the real model before
  turning memory on by default. Target: pynote's numbers (5/5 facts kept, no leak).

## 10. Order and size

1. Migration, Qdrant module, store, schema and operators, with unit tests. About 3 days.
2. Extraction, ingest, dedup and patches; internal `remember`; usage rows. About 3 days.
3. Retrieval, ranking, context; internal `recall`; runtime plugin (both hooks). About 3 days.
4. Lifecycle (compress, expiry, merging keys, keyword graph) and the 6-hourly sweep. About 2 days.
5. User and admin routes, delete hooks, FE (Settings tab, chat switch, org switch). About 3 days.
6. e2e and the UAV bench with the real model; tune thresholds. About 2 days.

## 11. Open questions

| # | Question | Proposal |
|---|---|---|
| M1 | Qdrant version of the company server (sparse IDF needs ≥ 1.10) | ask infra; fallback in §5.2 |
| M2 | Memory on by default for everyone? | off until the UAV bench passes with the real model, then on |
| M3 | Remember in data-analysis chats (python results, dataset figures)? | yes, the figures the user accepts are what matter there |
| M4 | Expose a `memory_search` tool to the model? | later; the block covers the common case |
| M5 | Retention of memories for a user who never chats again | none (deleted with their chats); revisit with the user lifecycle |

## 12. Guarantees: per-user isolation, and no impact on the main flow (confirmed 2026-10-23)

### 12.1 Every read and write is one user's
- **Who the user is never comes from the model.** `userId` is set by the gateway when it opens the chat. It is the
  `user` param on the runtime connect, from the login token, and the runtime keeps it in `agent.options`. The plugin
  sends that value; no tool or prompt can change it.
- **The gateway checks it again** on `/internal/memory/*`: the chat (`sessionId`) must belong to `userId` in
  `discovery_sessions`. Otherwise the call is refused and logged.
- **MariaDB:** every query has `where user_id = ?`, plus `session_id = ?` for chat memories. The store functions take
  `userId` as a required argument; there is no "all users" query outside admin maintenance.
- **Qdrant:** the vector module builds the filter itself from the required `userId` (`must: user_id = …`, and
  `session_id` / `scope` when needed). There is no search without that filter, and a unit test checks every call.
- **Two layers inside one user:**
  - `session` memories only show in their own chat.
  - `user` memories (role, lasting conventions) show in that user's chats only.
  - A project chat's figures stay in that chat. The project's other chats do not see them unless the user says they
    hold everywhere.
- **User routes** (`/memory…`, `/sessions/:id/memory`) act only on the caller's own memories and answer **404** for
  anyone else's id, as the other per-user routes do.
- **An admin cannot read other users' memories.** Admins can only turn memory off for the organization, and see its
  cost on `/admin/usage`.
- **Excluded:** subagents (their parent's turn is what is remembered), Data Studio chats, and runs with no user.
- **Tests:** another user's list, edit and delete return 404; a figure from one chat does not show in another chat;
  `/internal/memory/*` without the secret, or from outside, is refused.

### 12.2 The main flow is not slowed or broken
| Step | Runs | Effect on the turn |
|---|---|---|
| Remember (extraction, ~1 LLM call) | **background**: the plugin sends and does not wait; the gateway answers 202 and queues | none; the reply is never held |
| Maintain (compression, expiry, merging keys) | **background**, every 6 h per user, after a remember | none |
| Usage rows, logs | background | none |
| Recall (start of a turn) | **before the first model call of the turn**, with a hard cap | waits at most `MEMORY_RECALL_TIMEOUT_MS` (default 4.000 ms); usually one embedding + one Qdrant query + a few indexed MariaDB reads, expected ≈ 100–400 ms |

- Recall is the only step on the turn's path, because the memory has to be in the prompt before the model answers.
- **Any failure means "no memory this turn":** timeout, gateway or Qdrant down, a bad answer. The turn goes on as
  today, and a log line (`memory_recall_failed`) is written. Memory never makes a turn fail.
- Recall reads what is already committed and **never waits for a running extraction**: there is no lock shared with
  the background work.
- **Extraction load is capped** (`MEMORY_CONCURRENCY`, default 4 users at a time) so it cannot take all of the LLM from
  live chats. When the queue is long, a turn's extraction waits; chats do not.
- **The model never waits on a memory tool:** there is none (M4).
- **To cut recall's wait further:**
  - lower `MEMORY_RECALL_TIMEOUT_MS` (e.g. 1.500);
  - or, later, compute the next turn's block right after each remember finishes, so recall is a cache read.

## 13. As built (2026-10-23)

| Part | Where |
|---|---|
| Runtime plugin | `api/packages/memory` (`@fox-harness/dsh-memory`, in the profile's bundles): `agent/pre-step` step 1 → recall, `session/event` turn/end (completed) → remember; `inject: ['agents']` |
| Gateway service | `api/services/gateway/src/memory/`: `schema.ts` (pynote.yaml), `extract.ts` (pynote's rules verbatim, scope guard), `operators.ts`, `patch.ts` (difflib ratio port), `lifecycle.ts`, `rank.ts`, `core.ts` (MemoryBase: ingest, retrieval, context, maintain, consolidate, repair, member view), `store.ts` (MariaDB), `qdrant.ts` (REST, filters built from the required user id), `llm.ts` (chat JSON, embeddings with e5 prefixes + cache, rerankers), `service.ts` (switches, per-member queue, concurrency, usage, logs) |
| Routes | `POST /internal/memory/recall`, `/remember` (loopback + secret, else 404; not in nginx's API paths); `GET /memory`, `PATCH`/`DELETE /memory/:id`, `POST /memory/clear`, `PUT /memory/settings`, `GET`/`PUT /sessions/:id/memory`, `GET`/`PUT /admin/memory` |
| Delete hooks | chat purge and project delete → `forChatDeleted` (chat-scope rows + Qdrant points; the chat's switch row) |
| Storage | `api/migrations/003_memory.sql`; Qdrant `<prefix>memory_events` (dense + `terms` sparse IDF), `<prefix>memory_entities`, `<prefix>memory_keywords`; `qdrant/qdrant:v1.12.4` in `docker-compose.yml` and the e2e stack |
| FE | Settings → Bộ nhớ (`settings/MemoryTab.tsx`, `memoryApi.ts`), the chat's switch on the title bar (`SessionTitleBar.tsx`), `primitives/Switch.tsx`, a "long-term memory tokens" tile on `/admin/usage` |
| Tests | `pnpm test:memory` (api): 17 unit + 15 integration on a real MariaDB and Qdrant with a scripted model and a hashing embedder (pynote's tests ported); e2e `memory` (28 checks: correction with "(trước: …)", no leak across chats, lasting vs "this chat only", isolation, internal routes, switches, usage rows, restart, purge incl. Qdrant points). The mock LLM answers `/embeddings` and the memory prompts (`MEM {json}` in a user message) |

Differences from the plan:
- One retry happens inside `llm.ts` per model call (timeout / 429 / 5xx); the whole ingest is not retried, since part
  of it may already be stored.
- Session titles are generated by dsh and not counted; recall's embedding call is counted on the chat's turn.
- The memory block is not cached between turns (M-later: compute it after each remember).
- The organization switch can be set by the deployment: `MEMORY_ORG=1` / `0` (then `PUT /admin/memory` answers 409 and the
  Settings switch is read-only); unset, the admin's switch in Settings decides, off until turned on.

### 13.1 Qwen fixes (2026-10-23, from pynote-be's newer source)

Measured on Qwen3.5-35B in a real chat: the extractor stored the assistant's own words as the member's memory (a task
"Cung cấp tên 3 xã: open" from the assistant's question, "báo cáo: đã hoàn thành" from its claim).
- **The assistant's words are context only** (rule 9 in `extract.ts`): no proposal, plan, question, draft or "done"
  from the assistant alone. A figure the assistant gave counts once the member accepts it. To judge that, the plugin
  also sends the **previous turn** (its last request and the end of its answer) as read-only `context` to
  `/internal/memory/remember`. In code: an event whose segment holds no new message of the member is dropped.
- **Time in code, not by the model** (pynote's `timeparse.py` → `timeparse.ts`): rule 5 now asks for the phrase as
  said ("thứ Sáu tuần sau"); `core.ts` works out the date from the member's day (+07:00), e.g. "thứ Sáu tuần sau
  (30/10/2026)". It applies to `date` properties (`fact.when`, `task.when` → `ChatTask.hạn`) and to a fact whose key
  names a time ("hạn nộp"). A date the model added is redone. Retrieved events show "(khi: …)" when the time is not
  in their sentence. pynote measured "when" questions on LOCOMO more than 20 points behind Mem0 with the model
  converting dates.
- Still seen: a question about a fact ("hạn nộp là ngày nào?") can rewrite that fact's `note` ("người dùng xác nhận
  lại"). The value stays right.

