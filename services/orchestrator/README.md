# Orchestrator

Spawn, hibernate, rehydrate, TTL, warm pool (roadmap §1.2). Never knows session
content — only affinity/lifecycle. Also materializes
`$DSH_HOME/profiles/fox-harness/` from `@fox-harness/profile-template` per
session (roadmap checklist item 5) — control-plane config work, not something
`dsh` does on its own.

Container-built, never published, never imports a `@fox-harness/dsh-*`
package — only `@fox-harness/contracts` (docs/code-rules.md §1).

**REMOVED 2026-09-08 (Phase 16, docs/agent-core-architecture-roadmap.md):**
every mention below of `plugin_catalog`, `services/plugin-registry`, or
"approved plugin" describes a mechanism that's now gone — real need turned
out to be "every user gets the same fixed capability set," not "each user/
session picks their own," which is the only thing that whole mechanism ever
supported. `src/postgres.ts` (the file that queried `plugin_catalog`) is
deleted; `src/materialize.ts` now just copies the template's
`profile.package.json`/writes the transport override row, nothing else. Kept
below for the historical record, not because it's still accurate.

## Design

- **Redis affinity + spawn lock** (`src/redis.ts`) — `fh:session:<id>` holds
  `{containerId, host, port, dshHomeDir, status}` as JSON; `fh:lock:spawn:<id>`
  is a `SET NX PX` lock so two concurrent requests for the same new/dead
  session can't double-spawn (the loser polls for what the winner produces —
  `ensure.ts`'s `waitForLockHolder`).
- **Container lifecycle** (`src/docker.ts`) — `dockerode` (same "one focused
  library per real protocol" choice as `ws`/`ioredis` elsewhere in this repo,
  not a CLI-shelling wrapper). `spawnWorker()` always creates a BRAND-NEW
  container, `dshHomeDir` bind-mounted as `/data` ($DSH_HOME) — this is true
  for a session's first boot AND every rehydrate. **Never restarts an old
  container.** This is deliberate: it's what actually exercises "state comes
  only from the log" (roadmap §0.4) instead of quietly relying on in-container
  memory surviving. Hibernate (`removeWorker()`) stops + removes the
  container, keeping only its bind-mounted directory.
- **Materialize** (`src/materialize.ts`) — writes
  `<dshHomeDir>/profiles/fox-harness/{package.json,cordis.patch.yml}` from
  `@fox-harness/profile-template`, plus a container-specific override
  (`fox-harness-transport`'s `host` -> `0.0.0.0`, required for Docker's
  published port to reach it — the package default, `127.0.0.1`, only
  accepts loopback). Idempotent (skips if the files already exist), so a
  rehydrate reuses exactly what a first boot wrote.
  **Phase 5 addition:** on first materialize (not on a rehydrate — see
  `src/postgres.ts`), queries every `plugin_catalog` row with
  `review_status='approved'`, pushes each into `bundles`, copies its built
  artifact (`services/plugin-registry`'s `PLUGIN_REGISTRY_DATA_DIR/artifacts/<id>`,
  a shared-filesystem coupling honestly scoped to this dev environment — see
  `config.ts`) into `node_modules/<id>/`, and writes a `disabled: true`
  override row for it in `cordis.patch.yml`. This is deliberate over-provisioning:
  `dsh`'s real live-reload can only flip an existing patch row, never add a
  bundle that wasn't in the list at boot (docs/code-rules.md §20) — so every
  approved plugin has to be present-but-disabled from the start for
  `plugin-registry`'s later enable/disable to have anything to flip. A plugin
  approved AFTER a session already materialized is invisible to it until a
  rehydrate (fresh container, same `dshHomeDir`, this function runs again).
- **Warm pool** (`src/warmpool.ts`) — keeps `WARM_POOL_SIZE` containers
  pre-started with their own (not-yet-assigned) directories in Redis list
  `fh:warmpool`; a brand-new session claims one instantly instead of paying
  cold-start, and a background replenish tops the pool back up. Only covers
  NEW sessions — a rehydrate always needs its own specific `dshHomeDir`, so a
  pool container can't stand in for one.
- **`ensure.ts`** — the one operation `services/gateway` calls per connection:
  guarantee a live worker for a session id, return `{host, port}`. Existing +
  reachable -> reuse. Existing but dead (hibernated by the sweep, or killed
  out-of-band — both look identical here) -> rehydrate: fresh container, same
  `dshHomeDir`. Unknown -> claim from warm pool, or cold-spawn if the pool is
  empty.
- **Idle sweep** (`src/sweep.ts`) — `SWEEP_INTERVAL_MS`-periodic; any session
  idle past `IDLE_TTL_MS` (no gateway `touch()` — connect/disconnect only, no
  heartbeat timer) gets hibernated. **Known gap, not yet done:** doesn't check
  `Agent.status`/`whenIdle()` before hibernating — a session generating a long
  reply with no browser attached can be hibernated mid-turn today. Doesn't
  block the Phase 3 completion test (which is exactly this scenario, just
  triggered manually via `kill -9` instead of the sweep) but is a real product
  gap before this ships for real users.

## Config

`process.env`, loaded via `process.loadEnvFile()` — see `.env.example` at
repo root for the full list (`ORCHESTRATOR_PORT`, `REDIS_URL`, `WORKER_IMAGE`,
`ORCHESTRATOR_DATA_DIR`, `WARM_POOL_SIZE`, `IDLE_TTL_MS`,
`SWEEP_INTERVAL_MS`), plus `OPENAI_API_KEY`/`OPENAI_BASE_URL`/
`OPENAI_MODEL_ID` forwarded verbatim into every spawned container's
environment (no `.env` file of its own inside a container). Orchestrator
itself has no `DATABASE_URL` (Phase 16 removed its only Postgres query,
`src/postgres.ts`, entirely — see below) — that var belongs to
`services/gateway` alone, but the full local dev stack still needs the
database running for gateway to work.

Local dev needs Redis + MariaDB (no `redis-server`/`redis-cli`/`mariadb`
CLI installed on this machine): `docker compose -f
infra/docker/docker-compose.dev.yml up -d`, then run
`infra/migrations/001_init.sql` once against it (migrated off
Postgres 2026-09-09 — prod's DB server is MariaDB, docs/code-rules.md's
MariaDB-migration section). And the worker image:
`docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .`
(from the repo root).

**Warm pool + Redis cache gotcha (Phase 5):** `fh:warmpool` (a Redis list)
only ever grows when a member is popped (`claimWarmPoolMember`'s
fire-and-forget refill) or at process boot — nothing re-checks its entries
against reality. If you manually `docker rm` pool containers or wipe
`ORCHESTRATOR_DATA_DIR/_pool/*` on disk to force a clean re-materialize (e.g.
to pick up a newly-approved plugin, see Design above), you MUST also
`redis-cli del fh:warmpool` — otherwise `replenishWarmPool`'s size check
still counts the now-nonexistent entries as "pool full" and silently spawns
nothing, no error logged.

## Phase 4: `profileVariant` test lever (2026-09-04) — REMOVED 2026-09-08

Removed entirely, not just the `'no-theme'` preset: its one real use
(excluding `@fox-harness/dsh-client-ui-theme` from a session's bundle list)
stopped meaning anything once the whole per-session UI-plugin mechanism was
removed (`docs/code-rules.md` §30) — there is no more per-session bundle
list to filter at all. `EnsureSessionRequest`/`ensureSession()`/
`materializeDshHome()` no longer take a `profileVariant`/`variant` parameter.
Section kept below for the historical record.

`POST /sessions/:id/ensure` used to accept an optional body `{profileVariant?:
string}` (`packages/contracts`'s `EnsureSessionRequest`) — an OPAQUE label,
never a real bundle name, kept that way specifically so this service still
never has to know bundle internals (docs/code-rules.md §1). `materialize.ts`
maps a fixed set of presets (currently just `'no-theme'`) to a bundles-list
filter applied when writing a brand-new session's `profile.package.json`.
Exists solely to give the roadmap's Phase 4 completion test ("hai session
bật bộ plugin khác nhau thấy hai màn hình khác nhau") something real before
Phase 5's Postgres-backed per-user toggle exists — not a product feature.

One consequence for `ensure.ts`: the warm pool only ever holds
default-variant members (nothing pre-spawns a `'no-theme'` container ahead of
time), so a request naming a variant skips pool-claiming entirely and
cold-spawns instead — claiming a default-variant pool member for a
variant-specific request would silently ignore the variant.

Verified with real data: two sessions, one default and one `no-theme`,
produced two different `profile.package.json` files on real disk (one with
`@fox-harness/dsh-client-ui-theme` in `bundles`, one without) and two
different real `GET /manifest` responses from their respective real worker
containers. Full writeup: docs/code-rules.md §18.

## Verified end-to-end with real data (2026-09-04) — Phase 3's own completion test, PASSED

The roadmap's own criterion: *"kill -9 container giữa session (không phải
shutdown sạch), rehydrate ở node khác, context phải nguyên vẹn."* Real
WebSocket client speaking `services/gateway`'s exact protocol, a real worker
image, a real self-hosted model:

1. Connected (`/sessions/new`), sent a followup, got a real streamed reply
   from a warm-pool-claimed container (no cold-start delay).
2. Confirmed the real container via Redis (`fh:session:<id>`) — genuinely
   running, `docker inspect` agrees.
3. `docker kill --signal=KILL <containerId>` — a real hard kill, not a clean
   shutdown — on the actual container.
4. Reconnected through the gateway to the same session id ~4s later.
5. Orchestrator transparently spawned a brand-new container (different id,
   confirmed by comparing container ids before/after), mounted on the exact
   same `dshHomeDir`. Replayed snapshot: `turn/end` count 1, `assistant/message`
   count 1, full reply text present, matching what was streamed live before
   the kill.

Also verified separately: idle-TTL hibernate (5s TTL, 3s sweep interval —
confirmed `docker stop`+`rm` and a Redis status flip to `hibernated`) followed
by a successful rehydrate of that same hibernated session.

"Rehydrate ở node khác" is proxied here by "a brand-new container, zero
shared memory with the old one" — this dev machine has one Docker daemon, no
real multi-host test is possible locally. This satisfies the invariant the
test is actually probing (state survives independent of any specific
process), just not literally across physical nodes.

## Real bugs found getting here (see docs/code-rules.md §17 for full detail)

1. **`resume()` was a stub** (`packages/agent-driver`) — the actual
   prerequisite for all of this, found and fixed before any Docker work
   started.
2. **`insert:` in a `cordis.patch.yml` does not override an existing row by
   id — it's an unconditional append.** Using it for `materialize.ts`'s
   `fox-harness-transport` host override produced two rows with the same id
   and a hard `"duplicate loader entry id"` boot failure. The real override
   shape is `{id, ...fields}` with NO `insert:` key.
3. **`node-pty` (a real `dsh-base` dependency chain via `dsh-subprocess-local`
   — bash tool, fs-search tool, sandbox policy all need it) has no working
   prebuild on Alpine (musl).** Switched `infra/docker/worker/Dockerfile`'s
   base from `node:22-alpine` to `node:22-slim` (glibc). Disabling the
   `subprocess` row instead (tried first, to dodge the native-module issue)
   just breaks 4 *other* rows that depend on it — boot refuses to start with
   any entry left "pending".
4. **`@fox-harness/*` bundle packages don't resolve from inside
   `$DSH_HOME/profiles/fox-harness/`** the way `@deepseek-ai/dsh-base` does
   automatically — real host testing profiles get there via `pnpm install`
   with `link:` dependencies; `infra/docker/worker/entrypoint.sh` does the
   equivalent instantly with one symlink to the image's own already-hoisted
   `node_modules/@fox-harness`.
5. **A started container isn't a ready one.** `dsh`'s full plugin-tree boot
   takes a few real seconds; Docker publishes the port immediately. A plain
   TCP connect-then-close was NOT a reliable enough readiness check (still
   intermittently reset — likely Docker Desktop's port-forwarding proxy
   accepting the handshake before the container's real listener does).
   `docker.ts`'s `waitUntilReachable()` does a real WebSocket handshake
   against `packages/transport`'s actual protocol instead.
6. **The real data-loss bug this whole test exists to catch:** a session's
   final turn was genuinely unflushed to disk (checkpointing is lazily
   deferred to the *next* request — `@deepseek-ai/dsh-session-checkpoint-policy`'s
   own doc comment), even though live subscribers had already been notified.
   Fixed in `packages/agent-driver/src/agent.ts` — see that package's README.

## Phase 6: quota + telemetry + log retention (2026-09-07)

Real code + real tests for 3 of Phase 6's 5 checklist items (item 3, the
upstream-upgrade smoke test, lives at `scripts/upstream-smoke-test.mjs` and
`docs/upstream-upgrade-policy.md`; item 5, microVM isolation, is a written
strategy only — `docs/microvm-isolation-strategy.md` — this project has no
real user identity yet, so "quota theo user" throughout is either GLOBAL
(concurrent sessions) or PER-SESSION (everything else) instead:

- **Concurrent-session cap** (`config.maxConcurrentSessions`,
  `MAX_CONCURRENT_SESSIONS`) — `ensure.ts` rejects a brand-new session with a
  `QuotaExceededError` (→ HTTP 429, and `services/gateway` maps that through
  to a `429` WS-upgrade response) once `listRunningSessionIds().length`
  reaches the cap. Never rejects an existing/reconnecting session — a cap
  that could evict mid-conversation would violate roadmap §0.4. Racy under
  concurrent brand-new requests by design (same "safe to overshoot by a
  little" tradeoff as `warmpool.ts`'s replenish) — not worth exact atomic
  coordination for a soft capacity guard.
- **Max session age** (`config.maxSessionAgeMs`, `MAX_SESSION_AGE_MS`) —
  `sweep.ts` hibernates ANY running session past this total age, regardless
  of activity (unlike `IDLE_TTL_MS`, which a constantly-active session never
  trips). `SessionRecord.createdAt` (redis.ts) is set once at real creation
  and carried through every rehydrate — a session can't reset its own age
  quota by being repeatedly killed and rehydrated.
- **Per-session token budget** — NOT here, lives in-worker
  (`packages/core/src/quota.ts`) since real-time token usage is only ever
  visible there. `SESSION_TOKEN_BUDGET` is forwarded into every spawned
  container via `config.workerEnvPassthrough`, the same mechanism
  `OPENAI_MODEL_ID` already uses.
- **Log retention** (`config.archiveAfterHibernatedMs`,
  `ARCHIVE_AFTER_HIBERNATED_MS`; `config.archiveDir`,
  `ORCHESTRATOR_ARCHIVE_DIR`) — `sweep.ts`'s archival pass compresses a
  session hibernated longer than this into a real `tar.gz`
  (`archive.ts`, shelling out to the real `tar` binary, same
  "one real system tool via execFile" pattern as `pnpm`/`curl` elsewhere in
  this repo) and removes the live directory. `ensure.ts` transparently
  restores it on the session's next `ensure` before spawning — a caller
  never needs to know a session was archived. `SessionRecord.status` gained
  an `'archived'` value for this. A local directory stands in for the
  roadmap's "Log store (object storage)" — honestly scoped to this dev
  environment, same tradeoff `services/plugin-registry`'s artifact store
  already makes.
- **Real delete-on-request** — `DELETE /sessions/:id` (this service) /
  `DELETE /sessions/:id` (proxied by `services/gateway`, no new route shape)
  stops the container if running, removes BOTH the live directory and any
  archive tarball (`archive.ts`'s `purgeSession`), and drops the Redis
  affinity record. Irreversible — unlike hibernate/archive, nothing can
  rehydrate a purged session; a later `ensure` on the same id just creates a
  brand-new one. Verified for real: purge, then reconnect to the same id →
  `{type:'error', message:'unknown session: ...'}`, not a resurrected one.
- **Cross-layer telemetry** — every `console.log` in the hot paths
  (`index.ts`, `sweep.ts`) is now structured JSON
  (`{ts, service:'orchestrator', event, sessionId?, ...}`), a ~6-line
  helper duplicated per-service (same "mirrored, not imported" convention
  as everything else cross-boundary in this repo — see `services/gateway`
  and `services/plugin-registry` for the same function, and
  `packages/transport` for the worker-side leg). Verified for real: one
  real chat turn through the full stack, `grep`ing the same `sessionId`
  correctly present in gateway, orchestrator, and worker (transport) logs.

All defaults are 0/off — an unconfigured dev setup behaves exactly as every
prior phase left it. Verified for real (not just typechecked): concurrent
cap rejecting a 2nd session with 429, a token-budget-exceeded turn actually
getting `agent/pre-step`-rejected (`turn/end` with `reason.kind==='blocked'`,
no further model call), max-age hibernating a session that was continuously
connected the whole time, and a full archive→restore round trip preserving
a real assistant reply byte-for-byte through compression.

## Phase 12 item 4: per-session model choice at creation time (2026-09-07)

`OPENAI_MODEL_ID` is no longer the ONLY value a spawned worker ever sees.
`config.allowedModels` (`OPENAI_ALLOWED_MODELS`, comma-separated; falls back
to a single-item list built from `OPENAI_MODEL_ID` when unset — every prior
phase's behavior, unchanged, for an unconfigured dev setup) is a real
allow-list a caller can pick from, ONLY for a brand-new session
(`ensure.ts`'s new `model` parameter, validated and rejected with
`InvalidModelError`/HTTP 400 if it's not in the list). The chosen value is
stored in Redis `SessionRecord.model` — the operational source of truth,
never duplicated into the database — and `docker.ts`'s `spawnWorker()` now takes
an explicit `modelOverride` that wins over the passthrough env's own
`OPENAI_MODEL_ID` value. Three spawn paths, three different rules:

- **Cold new spawn** — uses the caller's `model` (or `allowedModels[0]` if
  none given).
- **Rehydrate** (existing session, hibernated/killed container) — ALWAYS
  reuses `existing.model`, ignoring whatever `model` this particular
  `ensure` call carries. A rehydrate must never silently change what model a
  session's later turns use.
- **Warm pool claim** — only ever for a request naming NEITHER
  `profileVariant` NOR `model` (same rule Phase 4 already applied to
  `profileVariant` alone, now applied to both levers together — a caller
  naming either one skips the pool and cold-spawns with it instead of
  silently ignoring it). `warmpool.ts`'s `spawnPoolMember()` spawns pool
  members with `config.allowedModels[0]` EXPLICITLY (not "whatever
  `OPENAI_MODEL_ID` happens to be" — those two can diverge once
  `OPENAI_ALLOWED_MODELS` is a real multi-item list), so a claimed pool
  member's `SessionRecord.model` is always correctly `allowedModels[0]`.

`GET /models` (static, no session-scoping, no auth check — that's
`services/gateway`'s call, see that service's README) exposes the allow-list
for `apps/web`'s connect-form picker.

**Verified for real** (Node script + `docker inspect`, `OPENAI_ALLOWED_MODELS`
set to 2 values for the test): a session created with the real model
completes a real chat turn; a session created with a second (fake, env-only)
model has that exact value in its container's real `Env`; killing that
container and reconnecting spawns a genuinely different container whose env
STILL carries the original model, not a silent revert to the default; the
warm pool, once replenished, holds members whose env carries
`allowedModels[0]`. Full writeup: `docs/code-rules.md` §27.

## NOT yet done / known gaps

- Idle sweep doesn't check whether an agent is mid-turn before hibernating
  (see Design above).
- No mid-session model change (`sessions.selectModel`-style live RPC, the
  way real dsh supports it) — a deliberate Phase 12 scope cut, see the
  roadmap's "Ngoài phạm vi".
- The per-session token budget (`packages/core/src/quota.ts`) resets on
  hibernate/rehydrate — its counter is in-memory only, not persisted or
  reconstructed from the session log on boot. Documented there, not hidden.
- No real per-user identity anywhere in this project — every Phase 6 quota
  is global or per-session, never truly per-user (same scope cut Phase 5's
  `session_enabled_plugins` already made).
- `infra/docker/worker`'s image is not size-optimized (whole repo copied in,
  full reinstall inside the image).
- No true multi-node — one Docker daemon, one `ORCHESTRATOR_DATA_DIR` on one
  host. Real multi-node affinity (Redis genuinely picking between multiple
  orchestrator-managed hosts) is unbuilt; the current Redis usage is real but
  only ever has one "node" to route to in this environment.
- A claimed warm-pool container keeps its pool-time Docker labels forever
  (labels are immutable post-creation) — `docker ps --filter
  label=fox-harness.session=<id>` won't find it. Redis
  (`fh:session:<id>`) is the actual source of truth; labels are only a
  best-effort debugging convenience for containers that were never
  pool-claimed.
