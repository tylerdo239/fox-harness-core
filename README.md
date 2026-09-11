# fox-harness-core

Multi-tenant AI agent platform. A thin wrapper around
[`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek
Harness) — dsh supplies the single-user agent runtime (LLM adapter registry,
tool registry, the durable session/event log, the Cordis plugin system). This
repo adds the one layer dsh doesn't have: real multi-user accounts, one
isolated container per chat session, and a shared web UI.

## Design principle: thin fork, not a clone

fox-harness-core does not fork dsh. It depends on it as a real npm package and
runs it through dsh's own Cordis plugin runtime, replacing exactly one piece —
`core/agent-loop` (the turn/step/tool-call loop) — with `packages/agent-driver`,
a hand-written driver that mirrors dsh-agent-loop's real behavior closely
enough that a session-log diff between the two is event-for-event identical on
the same prompt. Every other dsh subsystem (LLM adapters, tool registry,
session/event log, plugin bundle system) runs unmodified.

The multi-tenant layer — accounts, per-session container isolation, a shared
UI — is 100% custom and has no dsh equivalent: `services/gateway`,
`services/orchestrator`, `apps/web`.

## Architecture

```
Browser (apps/web — one static React SPA, one build, shared by every user)
   │  HTTPS (auth, REST)  +  WebSocket (chat stream)
   ▼
services/gateway        — auth (MariaDB users + Redis sliding-TTL tokens), CORS,
   │                       transparent WS proxy. Runs NO agent logic itself.
   ▼
services/orchestrator   — container lifecycle: spawn / hibernate / rehydrate /
   │                       warm pool. One session = one dedicated container.
   ▼
Worker container (one per session) — a real `dsh` process running:
   packages/agent-driver         replaces core/agent-loop
   packages/core                 agent/request routing + quota
   packages/llm/openai-compat    real LlmAdapter (any OpenAI-compatible endpoint)
   packages/tool/duckduckgo-web-search
   packages/transport            WS server inside the worker
   — every capability is a FIXED bundle, identical for every user/session

Redis    — session affinity, warm pool, login tokens
MariaDB  — users, sessions
```

`packages/contracts` is the only package `services/*` import types from
outside their own code — a hard boundary: `services/*` never imports a `dsh-*`
package directly, and the services never import each other; they only talk
over real HTTP/WS.

## Components

| Path | Responsibility | Explicit boundary |
|---|---|---|
| `apps/web` | One static React SPA (esbuild IIFE bundle), URL-routed (`/`, `/chat/<id>`), i18n (vi/en), light/dark theme. | Talks only to `services/gateway`'s public REST/WS contract — no knowledge of the orchestrator or any worker. |
| `services/gateway` | Sole authentication/authorization enforcer. Issues and renews login tokens, owns `users`/`sessions`, proxies WS traffic byte-blind to the right worker. | Runs no agent logic; never imports a `dsh-*` package. |
| `services/orchestrator` | Container lifecycle only: spawn, hibernate on idle TTL, rehydrate on demand, warm pool, Redis-backed session→container affinity. | Never sees session content, never authenticates end users — only verifies the caller is gateway (shared-secret header). |
| `packages/agent-driver` | Replacement turn/step/tool-call state machine — `core/agent-loop`'s real job. | The only package that reimplements a dsh internal; everything else only *adds* to dsh through its real extension seams. |
| `packages/core` | Two listeners: route `provider`/`model` from env vars (`agent/request`), enforce per-session token budget (`agent/pre-step`). | |
| `packages/llm/openai-compat` | Generic `LlmAdapter` for any OpenAI-compatible `/chat/completions` SSE endpoint (OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio, OpenRouter, ...). | Additive — does not replace dsh's own default adapters. |
| `packages/tool/duckduckgo-web-search` | One tool, `duckduckgo_web_search`, no API key required. | |
| `packages/transport` | The WebSocket server running *inside* each worker container (snapshot-then-live protocol). | Binds `127.0.0.1` only — never reachable outside its own container; `services/gateway` is what makes it reachable to a browser. |
| `packages/contracts` | Type-only definitions shared between `services/*` and `apps/web`. | The only non-`dsh-*` package `services/*` may import. |
| `packages/profile-template` | Template files (`profile.package.json`, `cordis.patch.yml`) that `services/orchestrator` materializes into a real dsh profile per session. | Not a dsh bundle itself — a build-time template. |
| `infra/docker/worker` | The one real container image — a full dsh install running the 5 `packages/*` above as a fixed bundle. | Not session-specific; orchestrator bind-mounts per-session data in at boot. |

## Request lifecycle (one chat turn, end to end)

1. The browser holds a WS connection to `services/gateway`
   (`ws://.../sessions/<id>?token=...`), authenticated by a Redis-backed token
   that renews on every real REST call or WS frame (sliding TTL, not a fixed
   login countdown).
2. `services/gateway` proxies the connection byte-blind to the session's
   worker container, asking `services/orchestrator` to spawn/rehydrate/wake
   it first if needed.
3. The browser sends `{type: "followup", text}`. `packages/transport` inside
   the worker hands it to `packages/agent-driver`, which runs the real
   turn/step loop against dsh's session/event log — the durable source of
   truth, not the WS connection.
4. `packages/core`'s `agent/request` listener routes the call to
   `packages/llm/openai-compat`, which streams the real completion back as
   `assistant/chunk` events.
5. Every event is appended to the durable log *before* being fanned out to
   connected clients — a reload or a killed container mid-stream loses
   nothing: reconnecting replays a full snapshot, then continues live.

## Repository layout

```
apps/web/                  the one shared frontend
services/gateway/          auth + proxy                    (control plane)
services/orchestrator/     container lifecycle             (control plane)
packages/agent-driver/     dsh core/agent-loop replacement
packages/core/             request routing + quota
packages/llm/openai-compat/
packages/tool/duckduckgo-web-search/
packages/transport/        in-worker WS server
packages/contracts/        shared types
packages/profile-template/
infra/docker/worker/       the real worker container image
infra/docker/docker-compose.dev.yml   local Redis + MariaDB only
infra/deploy/               staging/prod deployment — NOT built yet, see below
infra/migrations/           MariaDB schema (canonical)
docs/                       architecture research, decision log, strategy docs
scripts/                    build, dev-serve, admin bootstrap, upstream smoke test
data/                       local dsh-home (gitignored)
```

## Running locally (dev)

Requires the Node version pinned in `.nvmrc`, pnpm `11.7.0` (via corepack),
and Docker.

```bash
cp .env.example .env                    # fill in OPENAI_*, generate ORCHESTRATOR_INTERNAL_SECRET
pnpm install

docker compose -f infra/docker/docker-compose.dev.yml up -d      # Redis + MariaDB
docker exec -i docker-mariadb-1 mariadb -u fox_harness -pfox_harness_dev fox_harness \
  < infra/migrations/001_init.sql

docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .

pnpm run build                                    # typecheck + build every package,
                                                   # including apps/web's esbuild bundle

pnpm --filter @fox-harness/orchestrator dev       # terminal 1
pnpm --filter @fox-harness/gateway dev            # terminal 2
node scripts/serve-web.mjs                        # terminal 3 — http://127.0.0.1:5173

node scripts/create-admin.mjs <email> <password>  # bootstrap the first admin account
```

Each service's own README documents its config in more depth
(`services/gateway/README.md`, `services/orchestrator/README.md`).

### Updating after a code change

All real data lives in 3 places, none of which the steps below ever touch:
the `fox-harness-redis-data`/`fox-harness-mariadb-data` named volumes (users,
sessions, login tokens), and `data/dsh-home/` on the host (every session's
actual chat log — bind-mounted into worker containers, never stored inside
one). Re-running the full sequence above is always safe **except**
`docker exec ... < infra/migrations/001_init.sql`, which is only needed again
if a *new* migration file was added (every statement in it is `if not
exists`, so re-running the same file is a no-op, not destructive — but there's
no reason to re-run it for a plain code change).

The minimal restart for each kind of change:

```bash
# services/gateway or services/orchestrator source changed:
pnpm run build
# Ctrl-C + re-run the affected service's `pnpm --filter ... dev` — a plain
# Node process, no data of its own. Clients auto-reconnect and replay from
# the durable log, so an in-flight chat doesn't lose anything either.

# apps/web changed:
pnpm run build
# scripts/serve-web.mjs reads files fresh from disk every request
# (Cache-Control: no-store) — no restart needed at all, just reload the page.

# any packages/* the WORKER bundles changed (agent-driver, core,
# llm/openai-compat, tool/duckduckgo-web-search, transport, profile-template):
docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .
# already-running worker containers keep the OLD image until orchestrator
# naturally hibernates/rehydrates them — session data is unaffected either
# way, it's never stored inside the container.
```

**Never run** `docker compose -f infra/docker/docker-compose.dev.yml down -v`
(explicitly deletes both named volumes) for a routine update — plain `up -d`
already picks up nothing-changed containers as-is, and `down` (even without
`-v`) removes the containers while the volumes above now survive that. If you
do need to fully reset local dev data on purpose, `down -v` is the real way
to do it — just not by accident.

### Backing up local data

Before anything genuinely risky (a manual schema edit, `down -v`, a MariaDB
version bump), take a real dump — cheap, and the only way to undo a mistake
that isn't covered by the volume itself:

```bash
mkdir -p data/_backup
docker exec docker-mariadb-1 mariadb-dump -u fox_harness -pfox_harness_dev fox_harness \
  > data/_backup/fox_harness_$(date +%Y%m%d%H%M%S).sql
```

Restore with the same file:

```bash
docker exec -i docker-mariadb-1 mariadb -u fox_harness -pfox_harness_dev fox_harness \
  < data/_backup/<file>.sql
```

`data/` is gitignored, so a backup left there never risks getting committed.
Redis is never worth backing up here — everything in it (login tokens,
session affinity, warm pool) is either short-lived or self-heals the next
time a client reconnects or a session gets touched.

## Configuration reference

Full list with defaults: `.env.example`. Variables every deployment must set
explicitly (no safe default): `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`OPENAI_MODEL_ID`, `ORCHESTRATOR_INTERNAL_SECRET` (shared secret between
gateway and orchestrator — both refuse to boot without it), `DATABASE_URL`.

## Deployment status

**Only one deployment flavor exists today: local dev**, exactly as described
above — every control-plane service runs as a plain host Node process; only
the worker is containerized.

**A second, staging/production-VM flavor does not exist yet.** Verified
against current source, not assumed:

- No container image for `services/gateway` or `services/orchestrator` — only
  the worker has a `Dockerfile`.
- No CI/CD pipeline anywhere in the repo.
- No deploy scripts, no process-manager config (systemd/pm2), no reverse
  proxy or TLS termination config. `services/gateway/README.md` already
  documents that TLS and keeping internal ports off the public network are
  deployment-time requirements the code itself cannot enforce.
- `infra/deploy/` is a placeholder — its own README states the target
  platform hasn't been decided.
- `scripts/serve-web.mjs` (serves `apps/web`'s build) is explicitly
  dev-scoped: `Cache-Control: no-store` on every response, no CDN-caching
  story.
- No environment-specific config split — `.env.example` covers dev values
  only; nothing exists yet for staging/prod values.

The one piece of a real "hand this to the systems/infra team" workflow that
*does* exist today is `docs/schema/` — a schema handoff document for
provisioning the MariaDB database on whatever server that team runs. Nothing
equivalent exists yet for the application tiers themselves (gateway,
orchestrator, the worker image, the web bundle).

Building the staging/prod path is a real, scoped project of its own — it
needs decisions this repo can't make on its own (target VM/provider, process
supervision, reverse proxy, secrets management, CI provider) before any code
gets written.

## Operations & maintenance

- **Database migrations** live in `infra/migrations/`, applied by hand
  (`mariadb ... < NNN_*.sql`) — there is no migration runner. `001_init.sql`
  is the current canonical schema (2 tables: `users`, `sessions`).
- **Bootstrap the first admin**: `node scripts/create-admin.mjs <email>
  <password>` — never over HTTP; `POST /auth/register` can never create an
  `admin` role.
- **Adding a new agent capability** (tool, LLM adapter, etc.): write a real
  package under `packages/` using dsh's real extension seams
  (`ctx.tools.register()`, `ctx.llm.registerAdapter()`, ...), add it to both
  `packages/profile-template/template/profile.package.json`'s bundle list
  *and* root `package.json`'s `dependencies` (both are required — pnpm's
  hoisted linker needs the latter to create the container-visible symlink),
  rebuild the worker image, redeploy. There is no per-user/per-session
  opt-in — every capability is fixed and identical for every session, by
  design.
- **Upstream (`dsh`) upgrades**: `scripts/upstream-smoke-test.mjs` +
  `docs/upstream-upgrade-policy.md`.
- **Debugging a session**: every log line across gateway → orchestrator →
  worker carries the same `sessionId` — grep it across all three to trace one
  session's full path.
- **Log retention**: `DELETE /sessions/:id` purges on request; sessions
  hibernated past `ARCHIVE_AFTER_HIBERNATED_MS` get tar'd off live disk
  (`ORCHESTRATOR_ARCHIVE_DIR`) and can be restored.
- **Known operational gap**: the warm pool's replenish step never deletes a
  replaced pool member's on-disk directory (`data/dsh-home/_pool/<uuid>`) —
  it accumulates indefinitely (observed: 76 orphaned directories after a few
  days of testing). Not yet fixed.

## Security posture

- `services/gateway` is the single authorization enforcer for anything
  reachable from outside — `services/orchestrator` only checks that its
  caller *is* gateway (a shared-secret header), never who the end user is.
  Both internal ports must stay off any public network; the code cannot
  enforce that, it's a network-topology requirement on whoever deploys this.
- Each session's agent runs in its own Docker container (never a shared
  process between users), with real per-container CPU/memory/PID limits and
  a bubblewrap sandbox around the bash/fs tools inside it. This is
  process-level isolation, not kernel-level — microVM isolation (gVisor) is a
  written strategy only (`docs/microvm-isolation-strategy.md`), not
  implemented.
- `OPENAI_API_KEY` is currently one shared secret forwarded into every worker
  container — no per-session credential isolation or LLM-call proxy yet.
- Full findings and fix status: `docs/security-performance-review-2026-09-09.md`
  and `docs/code-rules.md`.

## Further reading

- `docs/core-overview.md` — the fullest current-state snapshot: every
  component, the real dsh-based logic behind it, and a complete
  capability/gap checklist. Read this before this README for real depth —
  this file is a condensed entry point into it.
- `docs/agent-core-architecture-roadmap.md` — original design plan and the
  research behind each major architectural decision.
- `docs/code-rules.md` — chronological log of every real bug found and
  fixed, plus repo conventions (read before writing code).
- `docs/security-performance-review-2026-09-09.md` — full security/
  performance/bug review with file:line references.
- `docs/microvm-isolation-strategy.md`, `docs/object-storage-strategy.md` —
  written, not-yet-implemented strategies.
- `docs/schema/` — the DB schema handoff document for the systems/infra team.
- Per-package/service `README.md` — most detailed, updated alongside its own
  code.
