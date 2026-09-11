# @fox-harness/dsh-core

Bundle package for the product-specific components (roadmap §1.4, layer 2 of the
profile). Declares `dsh.bundle.patch` pointing at `cordis.patch.yml`.

## Third real component (2026-09-07): `src/quota.ts` — per-session token budget

Phase 6 checklist item 1. Lives here, in-worker, rather than
`services/orchestrator` (where the other two Phase 6 quotas live — see that
service's README) because token usage is only ever visible in real time
right here, as this bundle's own `agent/request` listener (above) and the
LLM adapter actually make the call — giving the worker a Redis/MariaDB
connection just to report usage out would hand it a store connection it has
no other reason to hold (roadmap §1.2: "worker không biết gì về
multi-tenant"). Tracks cumulative `assistant/message.usage` per session
(`session/event` listener) and, when `SESSION_TOKEN_BUDGET` is set
(forwarded into the container by `services/orchestrator`'s
`workerEnvPassthrough`), rejects further steps via the `agent/pre-step`
waterfall once over budget — the same `reject | enter(messages)` gate
roadmap §2.2 already specifies, no new mechanism invented. A rejection closes
the turn with `reason: {kind:'blocked'}`, which
`packages/client-ui-conversation` already renders as a visible notice — no
new FE plumbing needed. **Known, documented gap:** the counter is in-memory
only, so it resets on hibernate/rehydrate; a real fix would replay usage
from the session log on boot (the same log-is-truth principle, roadmap
§0.4), out of scope for this pass. Verified for real: a real 2-turn WS
session with `SESSION_TOKEN_BUDGET=5` (small enough that turn 1 alone
exceeds it) — turn 1 completed normally, turn 2 was rejected before any
model call, no `assistant/message` produced for it.

## First real component (2026-09-03): env-driven model routing

`src/index.ts` now does one real thing, not just an empty `apply()`: it
listens on the `agent/request` waterfall (dispatched by
`@fox-harness/dsh-agent-driver`, verified real — see that package's README)
and overrides `provider`/`model` from the `OPENAI_MODEL_ID` launch-environment
variable when set, routing to `@fox-harness/dsh-llm-openai-compat`'s
`openai-compat` provider. This is what makes "set 3 env vars, no patch file
edits" actually work end-to-end — **verified working** via a real headless
run whose session log shows `assistant/message.source.provider ===
'openai-compat'` and the exact configured model id.

## Second real component (2026-09-04): `ctx.clientManifest` — REMOVED 2026-09-08

`src/client-manifest.ts` is deleted along with the whole per-session
UI-plugin delivery mechanism it backed (`docs/code-rules.md` §30,
`apps/web/README.md`) — `apps/web` is one single, normally-built static
bundle now, with nothing left to register a manifest entry FOR. A real bug
found removing this: `packages/transport`'s own `inject` array still
required the now-deleted `'clientManifest'` service, which would have left
that plugin permanently pending forever (Cordis `inject` never times out) —
caught by grepping for leftover references, not by a failing test. Section
kept below for the historical record.

`src/client-manifest.ts`'s `ClientManifestRegistry` (Phase 4) — a small
Cordis service any package with `dsh.client` self-registers into
(`packages/client-ui-theme`'s `apply()` is the one real caller so far),
queried by `packages/transport` to serve the FE boot manifest. Real
implementation + real gap hit getting the type augmentation to actually
cross the package boundary: docs/code-rules.md §18. `index.ts` re-exports
`ClientManifestRegistry`/`ClientManifestEntry` explicitly at its bottom —
don't remove that re-export even though nothing in this file's own `apply()`
signature seems to need it; TypeScript strips a value-only import from
declaration emit, which would silently make `ctx.clientManifest` invisible
to every consumer that only does `import '@fox-harness/dsh-core'`.

**Phase 5 addition:** `register()` now wraps its unregister in `ctx.effect()`
(so a plugin disposed by a live `cordis.patch.yml` change — Phase 5's
enable/disable — cleans up its manifest entry automatically, not just on
process exit) and emits a new `client-manifest/changed` event on every
register/unregister. `packages/transport` subscribes to that event per
connection and pushes a `{type:'manifest'}` WS frame so an already-open
browser tab learns about an enable/disable live, without reconnecting. A
plugin that never calls `register()` in its own `apply(ctx)` simply never
shows up here — this service does not scan `dsh.client` metadata to find
plugins on its own (docs/code-rules.md §18's "why not copy the real
Loader-tree scan" reasoning still applies, but it means a plugin author who
forgets the call gets no error, just silence; see
`services/plugin-registry/README.md`'s "known gaps" and
docs/code-rules.md §20 for a debugging story this cost).

**Phase 12 addition (2026-09-07):** `ClientManifestEntry` gained an optional
`slot?: { outlet: string; order?: number }` field — a package declares which
named DOM outlet `apps/web`'s shell should mount it into (`single` or
`list` kind, `apps/web/src/main.ts`'s `OUTLETS` map), server-declared same as
`immediately` above, never inferred client-side. Deliberately NOT a port of
dsh's real `ctx.slots` (a full client-side Cordis runtime — session-scoped
entries, chain election, per-entry error boundaries, hooks injection — read
in full from `dsh-client-ui-renderer`'s real 988-line source before deciding
this) — see `docs/code-rules.md` §27 for the full reasoning. An entry with
no `slot` keeps the pre-Phase-12 default (the center column), so every
package written before this phase needed zero changes.

## TODO before this is real (Phase 0)

- [x] Run `dsh --profile web --dump-config` against a real `@deepseek-ai/dsh` install —
      done 2026-09-03, 135 real rows captured at
      `docs/reference/dsh-web-profile-dump-config.yml`. The roadmap's "9 component"
      figure is confirmed wrong (see `docs/code-rules.md` §0.1).
- [x] Pick which of those 135 rows need a product component — first pass done
      2026-09-03. See candidate list below, grounded in the two decisions made
      the same day (roadmap §5): peak 1,000–10,000 sessions (revised
      2026-09-04, up from the original 100–1,000), **plugins run
      arbitrary code**.
- [ ] Split `src/index.ts` into `src/components/<name>/` — one file/dir per
      component below, as each gets implemented.
- [ ] `cordis.patch.yml` here inserts a placeholder row (`id: fox-harness-core`) —
      replace with the real per-component patch rows below as each is built.

## Candidate component list (first pass, from the real 135-row dump)

Every row below assumes a single local user (home-dir file, sqlite `:memory:`,
or local disk) — exactly the assumption that breaks under roadmap §0.4
(hibernate/rehydrate across nodes) and §1.2 (state lives in MariaDB/Redis/log
store, not on a worker's local disk). Grep used: `local|sqlite|:memory:|dshHomePath`
against `docs/reference/dsh-web-profile-dump-config.yml`.

**Critical — breaks the hibernate/rehydrate invariant if left as-is:**

| Row id | Upstream package | Why it must be replaced |
|---|---|---|
| `session-persistence-jsonl` | `dsh-session-persistence-jsonl` | Writes the session log itself to `dshHomePath('sessions')` — a worker-local path. This IS the log roadmap §0.4 calls the single source of truth; it must point at the shared log store (object storage), not a path that dies with the container. |
| `session-query-sqlite` | `dsh-session-query-sqlite` | `path: ':memory:'` — query index vanishes on hibernate. Needs a real backing store or a rebuild-from-log strategy on rehydrate. |

**Important — per-user state currently on local disk, needs to route through the control plane's stores instead:**

| Row id | Upstream package | Likely destination |
|---|---|---|
| `settings` | `dsh-settings-file` | MariaDB (roadmap §1.2's "config gì" table) |
| `credentials` | `dsh-credentials-local` | A real credentials seam — never plain local files for a multi-tenant worker |
| `storage-json` / `storage` | `dsh-storage-json` | Object storage or a per-tenant volume, not `dshHomePath('storages')` |
| `attachment-local` | `dsh-attachment-local` | Object storage |
| `file-reference-local` | `dsh-file-reference-local` | Object storage |
| `spill-local` | `dsh-spill-local` | Object storage (large tool-output overflow) |
| `jobs` | `dsh-jobs-local` | Depends on whether background jobs must survive hibernate — check before assuming a swap is needed |

**Security-critical given "plugins run arbitrary code" (roadmap §5 decision):**

| Row id | Upstream package | Note |
|---|---|---|
| `sandbox` | `dsh-sandbox-local` | Process/fs-level sandboxing alone is not enough for untrusted plugin code — this row must sit *inside* the per-user container/microVM boundary (docs/code-rules.md §7), not substitute for it. |
| `sandbox-policy`, `bash-sandbox`, `permission`, `approval` | various | Review each against the arbitrary-code decision — defaults tuned for a trusted single local developer, not an untrusted multi-tenant plugin. |

**Not flagged (fine to leave as upstream default for now):** `subprocess` (`dsh-subprocess-local`) — process spawning is inherently worker-local, not durable state.

This list is a starting point for review, not a final spec — each row needs its own decision (swap now vs. defer) before `src/components/` gets split out.
