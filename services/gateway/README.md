# @fox-harness/gateway

The backend's control plane **and** its supervisor of the agent runtime. It authenticates users, authorizes every
request by user id, proxies the chat WebSocket, owns per-user data (skills, working files, projects), enforces the
quota — and starts, watches and routes to the `dsh` runtime process(es) that run the agents. There is no
orchestrator and no per-session container: see `docs/single-backend-architecture-plan.md`.

Never imports a `@fox-harness/dsh-*` package (only `@fox-harness/contracts`, docs/code-rules.md §1): `dsh` is
started as a program. The chat protocol between a runtime and a browser is relayed byte for byte
(`src/proxy.ts`); the gateway does not parse it.

## Source layout

| File | Role |
|---|---|
| `src/index.ts` | HTTP routes, the WebSocket upgrade, start-up/shutdown. |
| `src/auth.ts`, `password.ts`, `redis.ts` | Accounts (scrypt), login tokens (Redis, sliding TTL, instantly revocable), rate limits. |
| `src/db.ts` | MariaDB: `discovery_users`, `discovery_sessions`, `discovery_projects`, `discovery_custom_skills` (`infra/migrations/001_init.sql`). |
| `src/runtime/supervisor.ts` | Starts `FOX_RUNTIME_COUNT` runtimes, readiness probe (a real WebSocket handshake), restart with backoff, shard routing `hash(sessionId) % N`, the per-boot secret, graceful stop. |
| `src/runtime/materialize.ts` | Writes the ONE dsh profile at start-up (`packages/profile-template/runtime/template`), links the flow presets. |
| `src/runtime/paths.ts` | Where things live: `<data>/users/<userId>/<sessionId>`, `<data>/projects/<projectId>`, `<data>/dsh-home`. |
| `src/runtime/sessions.ts` | Purge a session's data, delete a project's, find a working directory. |
| `src/runtime/skills-sync.ts` | Writes a user's skills into `<workspace>/.dsh/skills`. |
| `src/runtime/workspace-files.ts` | List / upload / download files of a working directory. |
| `src/runtime/live.ts` | Which sessions have a browser connected; the concurrent-session quota. |
| `src/skills.ts`, `object-storage.ts` | Skill rules and S3 storage of skill content. |
| `src/data-studio-*.ts`, `mongo.ts` | Data Studio's admin API (MongoDB). |

## HTTP / WebSocket API

All routes except `/auth/*`, `/models` and the probes need a token: `Authorization: Bearer <token>` (the WebSocket
takes `?token=` — browsers cannot set headers on an upgrade).

- `POST /auth/register` `{email, password≥8}` → `201` (always role `user`; admins only via `scripts/create-admin.mjs`).
  `POST /auth/login` → `{token, userId, email, role}`. `POST /auth/logout` revokes the token. Rate limited.
- `GET /healthz` (process answers) · `GET /readyz` (the gateway and every runtime can take a chat; `503` otherwise).
- `GET /models` — the model allow-list (no token: the login screen needs it).
- `WS /sessions/new?token=&flow=&model=&project=` creates a session; `WS /sessions/<id>?token=` reopens it.
  `flow` ∈ `default | data-analysis | data-studio`; `model` must be in `OPENAI_ALLOWED_MODELS`; `project` makes it a
  data-analysis chat in the caller's own project. Refusals happen before the upgrade: `401` no/bad token, `403` not
  yours, `400` bad flow/model/id, `404` unknown session, `429` quota, `502` runtime unavailable.
- `GET /sessions/mine`, `PATCH /sessions/:id` (rename), `DELETE /sessions/:id` (erase: runtime lets go, workspace and
  log are removed), `GET /sessions` + `GET /users` (admin), `GET /sessions/:id/plugin-inventory` (admin).
- `GET|POST /projects`, `PATCH|DELETE /projects/:id`, `GET /projects/:id/sessions`, `POST /projects/:id/promote`.
- `GET /sessions/:id/files`, `POST /sessions/:id/files?name=`, `GET /sessions/:id/files/<path>` — and the same under
  `/projects/:id/files`. Hidden paths are never listed or served; a path cannot leave the working directory.
- `GET /skills`, `GET|POST /custom-skills`, `PUT|DELETE /custom-skills/:name`.
- `/data-studio/*` — the semantic-layer admin API.

## How a connection is routed

1. Authenticate; check ownership (`canAccessSession`/`canAccessProject`; admin bypasses). A new session's id is minted
   here.
2. Everything the runtime needs comes from the **database row** (`flow`, `model`, `project_id`, owner) — a reconnect's
   URL cannot change them.
3. Quota (`MAX_CONCURRENT_SESSIONS`, `MAX_SESSIONS_PER_USER`, counted over sessions with a browser attached).
4. Create the workspace directory, write the user's skills into it, pick the shard, and (new session) insert the row.
5. Open the upstream connection with the secret header and `?flow=&model=&cwd=&user=&output=` and relay.
   Every client frame renews the sliding login token; the first marks the session as real (it then shows in the sidebar).

## Isolation

The gateway is the only place user identity exists. It builds every path from ids that passed authorization, hands the
runtime a per-boot secret (loopback is not a boundary — model-run code shares the machine), starts the runtime with an
allow-listed environment (no `DATABASE_URL`, `S3_*`, `REDIS_URL`), and runs it from a directory without a `.env`. It
refuses to start in production without the strict sandbox, or with a data directory inside a git checkout. The rest
(tool guard, sandbox) is described in the root README.

## Config

`src/config.ts` — plain `process.env`, `.env` loaded from the working directory. Required: `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Everything else has a default; `.env.example` lists them. The ones that
matter for a deployment: `DATABASE_URL`, `REDIS_URL`, `GATEWAY_DATA_DIR`, `FOX_RUNTIME_COUNT`, `OPENAI_*`,
`MAX_CONCURRENT_SESSIONS`, `MAX_SESSIONS_PER_USER`, `FOX_REQUIRE_SANDBOX`.

## Lifecycle

Start: check sandbox + data dir → materialize the profile → start the runtimes and wait until each accepts a real
WebSocket handshake → listen. A runtime that exits is restarted with backoff; its sessions resume from their logs on the
next connect. Stop (`SIGTERM`/`SIGINT`): stop listening, close browser sockets, `SIGTERM` the runtimes (they flush every
session log; `FOX_SHUTDOWN_GRACE_MS`, default 20 s, then `SIGKILL`).

## Logs

JSON lines to stdout with `sessionId`: `ws_connect`/`ws_disconnect`/`ws_*_rejected`, `purge_ok`, `skills_sync_*`,
`runtime_started`/`runtime_exited`. Runtime output is relayed prefixed `[runtime-N]`.
