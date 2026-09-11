# @fox-harness/gateway

Auth + transparent WebSocket proxy in front of `packages/transport`
(roadmap Phase 2 step 2: *"Gateway: auth cơ bản, phát token, proxy
stream"*). `packages/transport` has no auth of its own by design and
expects to sit behind exactly this (`packages/transport/README.md`).

Container-built, never published, never imports a `@fox-harness/dsh-*`
package — only `@fox-harness/contracts` (docs/code-rules.md §1). Runs no
agent logic itself: it issues tokens and relays raw WS frames verbatim.

**REMOVED 2026-09-08 (Phase 16, docs/agent-core-architecture-roadmap.md):**
`GET/POST /plugin-catalog`, `POST /plugin-catalog/:id/approve`,
`GET/POST /sessions/:id/plugins(...)`, and `config.pluginRegistryUrl` are
all gone — the whole per-user/session plugin catalog they served is gone,
`services/plugin-registry` deleted entirely. Real need turned out to be
"every user gets the same fixed capability set." `GET /sessions/:id/
plugin-inventory` (a read-only Cordis Loader diagnostic, unrelated to the
catalog/toggle mechanism) is NOT removed and still works exactly as before.

## Protocol

- `POST /auth/register` — body `{"email", "password"}` (password ≥ 8
  chars). Creates a real account, always `role: 'user'` — this endpoint can
  never produce an admin (Phase 7, see below). `409` if the email is taken.
- `POST /auth/login` — body `{"email", "password"}`. Replies `{"token",
  "email", "role"}` (a random 32-byte hex string, stored in Redis with a
  **sliding** TTL — `src/redis.ts`, 2026-09-09: `GETEX` renews it on every
  real REST call or WS `followup`/`steer` frame, so an actively-used
  session never hits a hard cutoff — see `docs/code-rules.md` §52) on
  success, `401` otherwise. `email` added 2026-09-08 — the FE had no way to
  know who's logged in before this (the request already looked up the user
  row to verify the password, so this costs nothing extra to return).
- `ws://host:port/sessions/new?token=...` /
  `ws://host:port/sessions/<id>?token=...` — same path shape as
  `packages/transport` itself. Token travels as a query param, not an
  `Authorization` header, because browsers can't set custom headers on a WS
  upgrade request. Missing/invalid/expired token → `401`; a valid token
  reconnecting to a session it doesn't own (and isn't `admin`) → `403` — both
  destroy the socket before any upgrade happens.
- Every other HTTP route (session rename/purge/plugin-inventory, the two
  admin listings) accepts the token either as a real `Authorization: Bearer
  <token>` header OR the same `?token=` query param —
  `src/index.ts`'s `identityFromRequest()`. The header is what `apps/web`'s
  `fetch()` calls use; the query param exists for the WS upgrade (browsers
  can't set custom headers on one) — historically it also covered a
  dynamically-`import()`-ed `client.js` that could set no header at all, but
  that whole per-session UI-plugin delivery mechanism (manifest,
  `client.js`) is gone (2026-09-08, docs/code-rules.md §30), and the plugin
  catalog/toggle routes that were listed here are gone too (Phase 16,
  2026-09-08 — see the note above).
- Once upgraded, `src/orchestrator-client.ts` calls
  `services/orchestrator`'s `POST /sessions/:id/ensure` (Phase 3 — replaces
  Phase 2's fixed target) to learn which worker is actually live for this
  session (spawning, rehydrating, or claiming a warm-pool member as needed),
  then `src/proxy.ts` opens its outbound connection there and relays every
  frame verbatim, both directions. The gateway does not parse or understand
  `packages/transport`'s wire protocol (`session`/`snapshot`/`event` /
  `followup`/`steer`) — that decoupling is deliberate, so the two can evolve
  independently.
- For a brand-new session (`/sessions/new` from the client), the gateway
  itself mints the id (`randomUUID()`) — it must know it before routing, to
  register affinity, so `packages/transport` can no longer be the one to mint
  it unobserved (see that package's README). It's passed through as
  `/sessions/new?id=<uuid>` to the worker; a reconnect (`/sessions/<id>`) is
  passed through unchanged.
- `touchSession()` pings orchestrator's `POST /sessions/:id/touch` on connect
  and disconnect — the one liveness signal its idle-TTL sweep gets, since the
  orchestrator must never know session content (roadmap).

Phase 2 was "một worker cố định, chưa multi-user" (roadmap); Phase 3 replaces
the one fixed `TRANSPORT_HOST`/`TRANSPORT_PORT` target with real per-session
routing through `services/orchestrator`. Phase 7 replaced the single shared
operator secret with real per-user auth (below).

## Config

Plain `process.env`, loaded via `process.loadEnvFile()` from the invoking
directory (same file `dsh` itself reads its `.env` from, but read directly
here since the gateway is a plain Node process, not a dsh profile — see
`.env.example` at repo root). Consolidated into `src/config.ts` in Phase 7
(previously 4 inline `process.env` reads in `index.ts`):

```
GATEWAY_PORT=4000                        # default
ORCHESTRATOR_URL=http://127.0.0.1:4100   # default — see services/orchestrator/README.md
DATABASE_URL=mariadb://fox_harness:fox_harness_dev@127.0.0.1:3307/fox_harness # default — Phase 7 users/sessions tables, MariaDB since 2026-09-09
REDIS_URL=redis://127.0.0.1:6379         # default — Phase 7 login tokens
TOKEN_TTL_MS=3600000                     # default (1 hour) — SLIDING since 2026-09-09, renews on every real request/WS frame, not a hard countdown from login
```

## Verified end-to-end (2026-09-03)

Booted a real worker (`fox-harness-transport-test` profile: `dsh-core` +
`dsh-agent-driver` + `dsh-llm-openai-compat` + `dsh-transport`, against the
same real self-hosted model used throughout this repo's testing) and this
gateway pointed at it, then re-ran Phase 2's own replay test — *"reload
trang giữa lúc model đang stream, nội dung phải dựng lại đầy đủ"* — through
the extra gateway hop instead of connecting to the transport directly:

1. `POST /auth/token` with the wrong secret → `401`; with the right secret
   → a real token.
2. Connected through the gateway's proxy (`/sessions/new?token=...`),
   completed one full turn.
3. Sent a second prompt, waited for a real mid-stream event, then **closed
   the socket while the model was still generating**.
4. Reconnected through the gateway to the same session id. The replayed
   snapshot had `turn/end` count 2 and the full second reply (1226 chars,
   verified against the actual streamed content) — completely present.

Confirms the extra hop doesn't break the log-before-fanout guarantee
`packages/transport` already provides — expected, since `src/proxy.ts` is a
byte-blind relay and can't reorder or race anything, but worth demonstrating
with real data rather than just asserting it from the architecture.

## One real bug found — in the *test script*, not the gateway

The first attempt at this test hung forever after connecting. Cause: the
test's `nextFrame()` helper used `ws.once('message', ...)` awaited one at a
time — but `packages/transport` sends `session` and `snapshot` back to back
with no `await` between them server-side, so both frames can land in the
same tick. If the second `.once()` listener isn't attached yet when that
happens, the event is gone — `EventEmitter` doesn't buffer. Fixed by
switching the test harness to a persistent `ws.on('message', ...)` listener
feeding a queue, with `nextFrame()`/`nextFrameOrTimeout()` reading from that
queue instead of racing a fresh listener per await. (A related latent bug
in the same first draft: a `Promise.race(nextFrame(), timeout)` pattern
left orphaned queue waiters on every timeout, which would have
mis-delivered a later frame to a stale waiter — fixed in the same rewrite
by having the timeout path remove its own waiter.) Not a gateway bug, but
recorded because it's the same "message arrives before you're listening"
class of bug worth remembering when writing the next WS test script.

## Phase 4: manifest + client bundle proxy (2026-09-04) — REMOVED 2026-09-08

Used to proxy `GET /sessions/:id/manifest` and
`GET /sessions/:id/plugins/*/client.js` to `packages/transport`'s matching
worker routes — the per-session UI-plugin delivery mechanism these backed
was removed entirely (`docs/code-rules.md` §30, `apps/web/README.md`).
`apps/web` is one single, normally-built static bundle now; there's nothing
left for this gateway to proxy on its behalf. `GET /sessions/:id/plugin-inventory`
(added Phase 12, see below) is real, independent infrastructure and was
kept — it never depended on the manifest mechanism.

## Phase 3: real per-session routing through services/orchestrator (2026-09-04)

Re-ran the exact same replay/kill test this README describes above, this
time through the full real chain — gateway -> orchestrator -> a real Docker
container: connected, sent a followup, got a real reply through a real
warm-pool-claimed container, `docker kill -9`'d that container mid-session,
reconnected through the gateway to the same session id, and the orchestrator
transparently routed to a brand-new container mounted on the same log
directory. Full history (the real reply text, not just event counts) was
present in the replayed snapshot. See `services/orchestrator/README.md` and
docs/code-rules.md §17 for the real bugs found getting there (none of them
were in this package — the gateway's own upgrade-handler change was a
straightforward swap of a fixed target for one `ensureSession()` call).

## Phase 6: quota propagation, delete-on-request, telemetry (2026-09-07)

Three small additions, all thin proxying — no quota/retention logic lives
here, it's all `services/orchestrator`'s (see that service's README for the
real design):

- **Quota-aware WS upgrade**: `orchestrator-client.ts`'s `ensureSession` now
  throws `OrchestratorHttpError` carrying the real HTTP status, so a
  concurrent-session-quota rejection (orchestrator's 429) reaches the
  browser as `HTTP/1.1 429 Too Many Requests` on the WS upgrade instead of
  collapsing into the same generic 502 every other `ensureSession` failure
  gets.
- **`DELETE /sessions/:id`** — proxied straight to the orchestrator's own
  purge route (`purgeSession` in `orchestrator-client.ts`), same byte-blind
  relay philosophy as everything else this gateway forwards.
- **Structured, `sessionId`-tagged logging** — `ws_connect`/`ws_disconnect`/
  `ws_ensure_failed`/`ws_quota_rejected`/`purge_ok`/`purge_failed`, same
  ~6-line JSON-to-stdout helper duplicated in `services/orchestrator` and
  `services/plugin-registry` (mirrored, not imported — see either's own
  comment for why). Verified for real: one chat turn's `sessionId` grep-able
  across gateway, orchestrator, and worker (transport) logs.

## Phase 7: real accounts, 2 roles, ownership enforcement (2026-09-07)

Replaced the entire Phase 2-6 auth model — no shared secret exists anywhere
in this codebase anymore. Full design + the architecture decisions made
along the way: `docs/agent-core-architecture-roadmap.md`'s Phase 7 section.
This service is the SOLE authorization enforcer (a deliberate choice over
defense-in-depth — `services/orchestrator`/`services/plugin-registry` do no
auth checks of their own, same as every phase before this one; only the
network boundary around their internal ports is what actually protects
them, a real tradeoff, not an oversight).

- **`src/db.ts`** — real MariaDB `users`/`sessions` tables
  (`infra/migrations/001_init.sql` — migrated off Postgres
  2026-09-09, docs/code-rules.md's MariaDB-migration section).
  `role='admin'` is reachable ONLY via `scripts/create-admin.mjs`, run
  out-of-band directly against the database — never through `register()`,
  never over HTTP.
- **`src/password.ts`** — password hashing via Node's built-in
  `crypto.scrypt`, not a native module (bcrypt/argon2 both ship native
  bindings — this repo already has one real native-module portability scar,
  `node-pty` on Alpine/musl, docs/code-rules.md §17 bug #3; scrypt needs
  nothing beyond what Node already ships).
- **`src/redis.ts`** — the login-token store (chosen over a stateless JWT
  specifically for instant revocation — see the roadmap's Phase 7 section
  for the full tradeoff). Replaces the old in-memory `Map`, which died on
  every restart and couldn't be shared across gateway replicas.
- **`src/auth.ts`** — `register()`/`login()`/`resolveIdentity()`/`logout()`,
  real credential checks against the tables above.
- **Ownership enforcement on every route** — `canAccessSession()` in
  `index.ts`: `admin` bypasses everything; a `user` must own the session
  named in the URL (`session_owners`, stamped once at session-creation time
  in the WS upgrade handler). A session with no ownership row (created
  before this migration ran, or some future race) falls through to
  admin-only — the safe default, not a special migration step
  (`infra/migrations/002_users_and_ownership.sql`'s own comment). This
  closed the single biggest pre-Phase-7 gap: every route this gateway
  proxies except the WS upgrade previously had NO token check at all.
- **New admin-only routes**: `POST /plugin-catalog/:id/approve` (previously
  reachable through this gateway by no one — plugin-registry's own approve
  endpoint was simply never proxied; now it is, and it's admin-gated — this
  was the single most severe gap, since approving is what actually lets a
  plugin's code run for real), `GET /users`, `GET /sessions` (gateway's own
  `session_owners` bookkeeping, never proxied to orchestrator).
- **`POST /plugin-catalog`** (submit a plugin for review) was originally any
  authenticated role; **tightened to admin-only 2026-09-08** — the catalog
  is now entirely admin-authored and admin-controlled, submission included,
  not just approval. A regular `user` account may only browse the approved
  catalog (`GET /plugin-catalog`) and enable/disable what's already there
  for their own sessions.

Verified end-to-end with real data, not just typechecked: registered 2 real
accounts + used the bootstrap admin, confirmed user B gets `403` reading or
WS-reconnecting to user A's session (both HTTP and WS paths), confirmed
admin bypasses that check, confirmed `GET /users`/`GET /sessions` are
admin-only, confirmed a regular user can browse but NOT submit (403,
2026-09-08 tightening) or approve a plugin
while admin can, confirmed a real chat turn still completes end-to-end for
the session's owner, and confirmed purge clears the ownership row (the
former owner gets `403`, not access to a resurrected session).

## Phase 12: real session directory, model-at-creation, plugin inventory proxy (2026-09-07)

`session_owners` renamed to `sessions` (`infra/migrations/003_sessions.sql`)
and gained `title`/`updated_at` — it's now a real, user-listable session
directory, not just an ownership join table:

- **`GET /sessions/mine`** — didn't exist before this phase; any
  authenticated user (not just admin, unlike `GET /sessions`) lists their
  OWN sessions, with a live `status` joined in from orchestrator's own Redis
  affinity record (`src/redis.ts`'s `getLiveSessionStatus` — a new
  read-only cross-service Redis read, same "shared store, not
  orchestrator-private" precedent Phase 5 already established for
  `services/plugin-registry`). Only returns sessions with
  `first_message_at IS NOT NULL` (2026-09-09, `infra/migrations/005`) — a
  session that was opened but never actually chatted in (every logout then
  login opens a fresh one, by design — `apps/web/src/App.tsx`'s own
  comment) no longer clutters this list forever. `first_message_at` is set
  by `src/proxy.ts`'s `onClientMessage` callback, which fires on the FIRST
  browser→worker WS frame without parsing it — `ClientToServer` only ever
  carries `followup`/`steer`, so any frame arriving there already IS a real
  message by the wire protocol's own contract, keeping the proxy's
  deliberate byte-blind design intact. Ownership itself (the `sessions` row
  insert) still happens eagerly at connect time, unchanged — deferring THAT
  instead would 403 a user who reloads right after opening a session but
  before typing anything.
- **`PATCH /sessions/:id`** — rename (ownership-or-admin, same check as
  purge). `src/db.ts`'s `touchSessionRow` also bumps `updated_at` on every
  real WS connect, so a session actually being used climbs back to the top
  of the "updated" sort.
- **`GET /models`** — the ONE route with no identity check at all (every
  other route requires one) — `apps/web`'s connect-form needs it before any
  login happens, to populate the model picker. Proxies to orchestrator's own
  `GET /models` (its `config.allowedModels`), byte-blind.
- **WS upgrade gained `?model=`** — only meaningful when `sessionPath==='new'`,
  passed through to `ensureSession()`'s new `model` parameter; an
  orchestrator 400 (`InvalidModelError` — a model outside its configured
  allow-list) now maps to a real `HTTP/1.1 400` on the socket, same
  treatment as the existing 429 quota case.
- **`GET /sessions/:id/plugin-inventory`** — new session-scoped, proxied
  route (same shape as the manifest/`client.js` routes) backing
  `packages/client-ui-plugin-inventory`.

## Follow-up fix: `POST /auth/logout` was never wired up (2026-09-07)

Real gap, found by checking the actual FE flow after a direct user question
("where's login/logout"): `src/auth.ts`'s `logout()` (real Redis token
revocation, Phase 7) existed but had no route calling it — `grep -n
"logout" services/gateway/src/*.ts` before this fix returned exactly one
hit, the function definition itself. Added `POST /auth/logout` (no full
`identityFromRequest` needed — just extracts the bearer/`?token=` value and
revokes it; idempotent, same tone as `register`/`login`'s own error
handling). Verified for real: the exact same token gets a real `401` on
`GET /sessions/mine` immediately after logging out with it.

## NOT yet done / known gaps

- No rate limiting on `/auth/login` (brute-forcible given enough attempts,
  though `timingSafeEqual` inside `verifyPassword` closes the timing
  side-channel on the hash comparison itself).
- No TLS termination here — assumed to sit behind a real TLS-terminating
  reverse proxy in any non-local deployment.
- No `POST /auth/logout` route wired up yet, even though `src/auth.ts`
  already has a real `logout()` (instant revocation via Redis `DEL`) —
  nothing calls it. Cheap to add, just not done.
- `services/orchestrator` and `services/plugin-registry` do no authorization
  checks of their own (Phase 7's explicit "gateway-only" decision, see
  roadmap) — if their internal ports (`:4100`/`:4200`) are ever reachable
  from outside a trusted network, every check this gateway does is
  bypassable by hitting them directly. Real deployment MUST keep those ports
  off the public network; this is a network-topology requirement, not
  something code here can enforce.
- No password reset flow, no email verification, no rate limiting on
  `/auth/register`.
