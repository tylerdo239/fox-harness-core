# fox-harness-core

Multi-tenant AI agent platform. A thin wrapper around
[`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek
Harness) — dsh supplies the single-user agent runtime (LLM adapter registry,
tool registry, the durable session/event log, the Cordis plugin system). This
repo adds the layer dsh doesn't have: real multi-user accounts, per-user
isolation of one shared agent runtime, and a web UI.

**Two deployable services, two folders:** `app/` (the web UI: nginx + React bundle) and `api/` (the backend:
gateway + the agent runtime it starts). Each has its own Dockerfile and builds from its own folder. Nothing else
is deployed by us. The root `docker-compose.yml` runs everything on one machine for local development only.

## Design principle: thin fork, not a clone

fox-harness-core does not fork dsh. It depends on it as a real npm package
(pinned at `0.1.1-rc.2`) and runs it through dsh's own Cordis plugin runtime,
replacing exactly one piece — `core/agent-loop` (the turn/step/tool-call loop) —
with `packages/agent-driver`, a hand-written driver that mirrors
dsh-agent-loop's behaviour (a session-log diff between the two is
event-for-event identical) and adds what one-process-many-sessions needs: a
scope per agent and the `setup` hook that joins an agent preset. Every other dsh
subsystem runs unmodified.

dsh is a single-user runtime: its own docs say agent scopes and presets are
*not* a security boundary. Everything that keeps one user's agent away from
another user's files is ours (see "Isolation" below).

## Architecture

```
Browser ──HTTPS──► web — app/ (nginx: static React bundle; forwards API + chat WebSocket)
                     │
                     ▼
                  backend — api/ (one container)
                  ├─ services/gateway   auth (MariaDB users + Redis sliding-TTL tokens), REST, authorization
                  │                     by user id, WebSocket proxy, per-user files/skills, quota
                  └─ N × `dsh` runtime  started and supervised by the gateway; each hosts MANY sessions.
                       (FOX_RUNTIME_COUNT)  A session is served by shard hash(sessionId) % N.

External (not deployed by us): MariaDB · Redis · S3 · MongoDB · Dremio · Meilisearch · the LLM endpoint
```

- A **flow** (`default`, `data-analysis`, `data-studio`) is a dsh **agent preset**
  (`packages/profile-template/presets/<flow>`): tools, persona and listeners
  scoped to the agents that joined it. One runtime process hosts agents of every flow.
- A session's state is its **log on disk** (`<data>/dsh-home/sessions/…`). Runtimes
  are stateless: kill one and each of its sessions resumes from its log on the next
  connect; idle sessions are dropped from RAM and resume the same way.
- The gateway tells the runtime everything it needs to open a session (flow,
  model, working directory, owner) on **every** connect, read from the
  `discovery_sessions` row — the runtime keeps no control state.

### Isolation (read this before deploying)

One runtime serves every user, so isolation between users is logical, not a
container boundary:

1. **Authorization** — the gateway checks the caller owns the session/project
   before touching anything; paths are built from ids that passed that check
   (`users/<userId>/<sessionId>`), never from client input.
2. **Tool guard** (`api/packages/transport/src/workspace-guard.ts`) — every tool call
   whose path argument leaves the session's own working directory (after
   following symlinks) is refused. dsh's own fs sandbox only fences *writes*.
3. **Strict sandbox for `bash` and `python`** (`api/docker/fox-confine.sh`)
   — bubblewrap with an empty root: only a minimal read-only system, the
   session's own workspace and a private `/tmp`. The environment is allow-listed
   (`env -i`) so the runtime's credentials never reach model-run code, and the
   network is cut (`--unshare-net`: only a loopback), so it cannot reach Redis,
   Mongo, MariaDB, the runtime or the internet. The boot self-test checks both.
4. **Runtime secret** — the gateway generates a per-boot secret; runtimes refuse
   any connection without it (loopback alone is not a boundary).

### Role-based data access

Two roles, `admin` and `user`. Admins create accounts, manage the semantic layer and dashboards; users chat, own
their files/projects/skills and read dashboards. Dremio is OSS (no row/column policies), and `analyze_data` runs one
shared Dremio account, so the data boundary is ours, in the Python pipeline
(`api/packages/tool/data-studio-agent/python/src/security/role.py`):

- The role comes from the gateway (session owner's role) → `agentOptions.role` → `analyze_data` (a subagent uses its
  root agent's role) → the worker. Missing anywhere ⇒ `user`. The model never sets it.
- Tables and columns carry `allowed_roles`; missing ⇒ admin only, and Dremio sync creates new ones admin-only. A
  `user` sees a table/column only if an admin opened it (Data Studio → Data sources, "allow user"), and never an
  `is_pii` one. Metrics, glossary terms and relationships touching a hidden table/column are hidden too.
- Filtered in the Mongo crud layer (every pipeline step reads through it), then enforced on the SQL:
  `sql_validator` refuses hidden tables/columns (aliases resolved, `SELECT *` and raw fragments refused for `user`),
  and `query_execution` re-checks the final SQL's tables right before Dremio.

Test: `api/packages/tool/data-studio-agent/python/tests/role_authz_test.py` (real Mongo) and the `roleGate` /
`roleReachesRuntime` e2e tests.

In production the gateway **refuses to start** without the sandbox
(`FOX_REQUIRE_SANDBOX`, on when `NODE_ENV=production`). The guard is a policy
fence with a check-then-use window and cannot read inside a `bash` command
line; the sandbox is the real boundary for `bash`/`python`. Measured results:
`docs/single-backend-architecture-plan.md` §13.

## Components

| Path | Responsibility |
|---|---|
| `app/` | The web UI: one static React SPA (esbuild IIFE bundle), URL-routed (`/`, `/chat/<id>`), i18n (vi/en), light/dark; nginx config + Dockerfile. Talks only to the gateway's REST/WS API; imports nothing from `api/`. |
| `api/services/gateway` | Auth, REST, WebSocket proxy, user-id authorization, per-user skills/files/projects, quota, and the **runtime supervisor** (`src/runtime/`): materializes the dsh profile, starts/restarts the runtimes, routes sessions to a shard. Never imports a `dsh-*` package. |
| `api/packages/agent-driver` | Replacement turn/step/tool-call state machine (`core/agent-loop`'s job), with per-agent scope and `setup` hook. |
| `api/packages/core` | Per-agent model routing (`agent/request`) and per-session token budget (`agent/pre-step`, rebuilt from the log). |
| `api/packages/transport` | The WebSocket server inside each runtime: snapshot-then-live protocol, one fan-out listener, idle disposal, flow join, tool guard. Loopback + secret only. |
| `api/packages/llm/openai-compat` | Generic `LlmAdapter` for any OpenAI-compatible `/chat/completions` SSE endpoint. |
| `api/packages/tool/*` | `serper-web-search`, `create-skill`, `python-repl` (one kernel per conversation), `data-studio-agent` (`analyze_data`, a pool of workers). |
| `api/packages/flow/data-analysis` | The data-analysis flow's working rules. |
| `api/packages/profile-template` | `runtime/template` (the ONE dsh profile every runtime boots) and `presets/` (one directory per flow). |
| `api/packages/contracts` | Type-only definitions shared inside the backend. |
| `api/docker/fox-confine.sh` | The strict sandbox runner for model-run `bash`/`python`. |
| `api/migrations` | MariaDB schema (one file). |

## Request lifecycle (one chat turn)

1. The browser holds a WebSocket to `/sessions/<id>?token=…` (through nginx).
2. The gateway authenticates the token, checks the caller owns the session,
   applies the concurrent-session quota, creates the workspace directory, writes
   the user's skills into it, and picks the runtime shard.
3. It opens a connection to that runtime carrying flow/model/cwd/owner and relays
   frames byte-for-byte.
4. The runtime creates or **resumes** the agent (joining the flow's preset), sends
   a snapshot of the log, then live events. The browser sends `{type:"followup",text}`.
5. Every event is appended to the durable log *before* it is fanned out — a
   reload, a restarted runtime or a restarted container loses nothing.

## Repository layout

```
docker-compose.yml         LOCAL DEVELOPMENT ONLY: web + backend + MariaDB, Redis, MinIO, MongoDB, Meilisearch, Dremio, MySQL
app/                       the web UI — its own pnpm project, Dockerfile, nginx config (docker build ./app)
api/                       the backend — its own pnpm workspace and Dockerfile (docker build ./api)
  services/gateway/          auth + REST + proxy + runtime supervisor
  packages/                  agent-driver, core, transport, contracts, llm/, tool/, flow/, profile-template/, skills/
  docker/fox-confine.sh      the strict sandbox runner
  migrations/                MariaDB schema (canonical)
  scripts/                   create-admin, smoke tests, spike/load harnesses, upstream smoke test, bench
scripts/                   end-to-end tests of the two images together (+ the mock LLM they use)
docs/                      architecture, decision log, deployment (docs/deploy.md), schema handoff
```

## Deploying

```bash
docker build -t fox-harness-web:<tag>     ./app
docker build -t fox-harness-backend:<tag> ./api
```

Each image is deployed on its own against real infrastructure: what to provide, the backend's capabilities,
environment, sizing and Kubernetes notes are in `docs/deploy.md`.

## Running locally (dev)

Requires Docker, the Node version pinned in `.nvmrc` and pnpm `11.7.0` (via corepack).

```bash
cp api/.env.example api/.env               # fill in OPENAI_*, EMBEDDING_*, SERPER_API_KEY, DREMIO_*
docker compose up -d --build               # everything; open http://127.0.0.1:8080
docker compose exec backend node scripts/create-admin.mjs <email> <password>
```

To edit code with instant reload, run only the infrastructure in Docker and the code directly:

```bash
docker compose up -d mariadb redis minio mongo meilisearch dremio mysql
cd api && pnpm install && pnpm run build && pnpm dev      # gateway + runtimes on :4000
cd app && pnpm install && pnpm dev                         # UI on http://127.0.0.1:5173 (talks to :4000)
```

On macOS the strict sandbox is unavailable (bubblewrap is Linux-only), so
`bash`/`python` run **unconfined** there — fine on your own machine, never for
real users. The full Docker stack (`docker compose up`) runs the real sandbox.

### Backing up local data

Everything lives in the compose project's volumes (`fox-harness_*`): `backend-data` (every session's log,
workspace and project), `mariadb-data`, `minio-data`, `mongodb-data`, `meilisearch-data`, `dremio-data`,
`mysql-data`. Dump the databases before anything risky:

```bash
docker compose exec mariadb sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --databases discovery-agent' > backup.sql
docker compose exec mongo mongodump --archive --gzip > mongo.archive.gz
```

Redis holds only login tokens and rate-limit counters; it is not worth backing up.

## Configuration reference

Full list with defaults: `api/.env.example` (the web container needs none). The root `.env.example` only holds
overrides for the local compose (ports, local passwords). Required: `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`OPENAI_MODEL_ID`, `DATABASE_URL`, `REDIS_URL`, `S3_*`.

## Operations & maintenance

- **Database**: `api/migrations/001_init.sql` is the whole schema. A new schema
  change is a new numbered file, written with `if not exists`; there is no migration runner.
- **First admin**: `node scripts/create-admin.mjs <email> <password>` from `api/` (or `docker compose exec backend ...`) — never over HTTP. Further accounts: an
  admin creates them in Settings → Users (`POST /users`); there is no self-registration.
- **Giving users data**: after a Dremio sync every new table is admin-only; open the ones users may query in
  Data Studio → Data sources.
- **Adding a capability** (tool, LLM adapter, …): a package under `api/packages/`,
  listed in `api/packages/profile-template/runtime/template/profile.package.json`
  (global) or in a flow's preset (that flow only), and in `api/package.json`'s
  `dependencies` and `api/tsconfig.json`'s references. Rebuild the backend image.
- **Upstream (`dsh`) upgrades**: `api/scripts/upstream-smoke-test.mjs` +
  `docs/upstream-upgrade-policy.md`. Newer dsh moves presets into plugin bundles
  and changes the log format — treat an upgrade as its own project.
- **Debugging a session**: log lines carry `sessionId` through the gateway and the
  runtime; runtime output is relayed with a `[runtime-N]` prefix.
- **Scaling**: raise `FOX_RUNTIME_COUNT` to use more cores. More than one backend
  replica needs sticky routing by session id and shared storage for the data directory.

## Testing

- `cd scripts && pnpm install` once, then `scripts/e2e-up.sh` + `node scripts/e2e-backend.mjs` — the two images
  end to end on a throwaway stack (:18080): real nginx → gateway → runtimes, mock LLM, real users, roles,
  isolation, sandbox, restart, purge. `scripts/e2e-down.sh` removes it.
- `api/packages/tool/data-studio-agent/python/tests/role_authz_test.py` — role-based data access against a real Mongo.
- `api/scripts/spike-single-runtime.mjs`, `api/scripts/spike-load.mjs` — runtime-level isolation and load
  harnesses (need a running runtime).

## Further reading

- `docs/single-backend-architecture-plan.md` — why and how the orchestrator was removed; measured results (§13).
- `docs/core-overview.md` — component-by-component snapshot.
- `docs/agent-core-architecture-roadmap.md`, `docs/code-rules.md` — original design plan and the chronological bug log.
- `docs/schema/` — the database schema handoff for whoever provisions MariaDB.
- `docs/deploy.md` — deploying the two images.
