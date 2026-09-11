# @fox-harness/dsh-transport

Real WebSocket event stream + command endpoint, running inside the harness
worker (roadmap Phase 2 step 1). Not Typert (docs/code-rules.md §0.3) — a
thinner protocol built for the worker↔gateway hop, which upstream has no
equivalent for (upstream's own transport, studied in `docs/code-rules.md`
§15, is single-process: browser talks directly to the one local harness).

## Protocol

One WebSocket connection = one session.

- `ws://host:port/sessions/new` — mints a fresh session (`ctx.agents.create()`),
  replies `{type:'session', sessionId}` first so the client can persist it
  (e.g. `localStorage`) for reconnect.
- `ws://host:port/sessions/<id>` — reconnects to an existing session.

Both paths then send `{type:'snapshot', events: SessionEvent[]}` (the
complete durable log so far) and continue with `{type:'event', event}` per
new durable event. Client → server: `{type:'followup', text}` /
`{type:'steer', text}`, converted to a real `UserMessage` and routed through
`agent.followup()`/`agent.steer()`.

**Deliberately snapshot-then-live, not resume-from-cursor** — matches the
real pattern found in upstream's own browser transport
(`docs/code-rules.md` §15): a reconnect is just a fresh logical connection
that gets a fresh complete snapshot + continuation, not a partial "give me
events after N" protocol. Simpler to implement correctly and is what made
the replay test below straightforward.

## Verified end-to-end (2026-09-03) — Phase 2's completion test, passed

Roadmap Phase 2's own criterion: *"test replay: reload trang giữa lúc model
đang stream, nội dung phải dựng lại đầy đủ."* Real test, real WebSocket
client, real model:

1. Connected, created a session, sent a prompt, got a real streamed reply.
2. Sent a second prompt, waited for streaming to start, then **closed the
   connection while the model was still generating** (simulating a page
   reload mid-stream).
3. Reconnected to the same session. The snapshot's `turn/end` count was
   already 2 — the agent kept running server-side, entirely independent of
   any specific WebSocket connection, and the full second reply (a
   multi-paragraph answer) was completely present in the replayed log.

This works because of one real, verified guarantee: `session/event`
(the Cordis event this transport subscribes to for the live half of the
protocol) is documented as "post-commit, fire-and-forget" — its own doc
comment says the callback fires strictly *after* the durable append
commits. Log-before-fanout isn't something this package has to get right by
careful ordering; it falls out of subscribing to the right hook.

## One real bug found and fixed along the way

Sessions created via `ctx.agents.create({sessionId, agentOptions: {}})`
**without** `meta: {cwd}` don't just leave `cwd` blank — they land in a
`_no-cwd` bucket in the session-log store instead of the normal
cwd-keyed directory (confirmed by hunting for a just-created session and
finding it wasn't where every other session in this repo's testing had
been). Every real session-creating app (`dsh-headless`, `dsh-web-app`) sets
this; fixed by passing `meta: { cwd: process.cwd() } }`. Also matters for
per-session sandboxing — `dsh-sandbox-policy`'s `workspaceRoot` defaults to
the *worker's* cwd, not necessarily the right thing without this.

## Config

```yaml
config:
  port: 4001        # default
  host: 127.0.0.1   # default
```

## Phase 3: rehydrate + pre-assigned session ids (2026-09-04)

Two protocol changes, both backward compatible with Phase 2 single-worker use:

- `/sessions/<id>` now falls back to `ctx.agents.resume({resumeSessionId: id,
  ...})` when `ctx.sessions.get(id)` misses — the expected case after a fresh
  container reattaches to an existing session's mounted log volume (a
  container restart, kill -9, or orchestrator-driven hibernate/rehydrate).
  Only reports "unknown session" if resume also fails (genuinely never
  persisted). See `packages/agent-driver/README.md`'s Phase 3 section for
  where `resume()` itself lives.
- `/sessions/new` accepts an optional `?id=<uuid>` — `services/gateway` must
  decide a session's id and register Redis affinity for it BEFORE opening the
  connection, so this transport can no longer be the one to mint it
  unobserved (the proxy is deliberately byte-blind — see
  `services/gateway/README.md`). Omitting `id` keeps Phase 2's original
  behavior (mint a random one), still valid for direct single-worker use.

## Phase 4-12: boot manifest + client bundle routes — REMOVED 2026-09-08

`GET /manifest`, `GET /plugins/<id>/client.js`, and the `{type:'manifest'}`
live-push (Phase 5, below) are all removed along with the whole per-session
UI-plugin delivery mechanism (`docs/code-rules.md` §30, `apps/web/README.md`)
— `apps/web` is one single, normally-built static bundle now. This left
`packages/core`'s `'clientManifest'` inject requirement here as dead weight
that would have silently hung this whole plugin forever (Cordis `inject`
never times out) — a real bug found by grepping for leftover references
after the removal, fixed by dropping it from `inject`. `GET /plugin-inventory`
(Phase 12, below) is real, independent infrastructure and was KEPT — it
never depended on the manifest mechanism. Sections below kept for the
historical record.

Refactored `startTransportServer` from the `new WebSocketServer({host,port})`
shorthand to an explicit `http.createServer()` + `WebSocketServer({noServer:
true})` + `server.on('upgrade', ...)` (matching `services/gateway`'s own
established pattern) — needed so the SAME port can also answer plain HTTP:

- `GET /manifest` — `ctx.clientManifest.list()` (`packages/core`'s
  `ClientManifestRegistry`, self-registration not Loader-tree scanning — see
  docs/code-rules.md §18), urls relative (`/plugins/<id>/client.js`).
- `GET /plugins/<id>/client.js` — resolves the real file via
  `import.meta.resolve('<id>/client')` (the package's own `exports["./client"]`
  field, docs/code-rules.md §0.2) and serves it as `text/javascript`.

`services/gateway` proxies both, rewriting urls so the browser never talks to
this port directly (same reason it already proxies the WS endpoint — see its
own README). Verified end-to-end with real data through that full proxy
chain: docs/code-rules.md §18.

## Phase 5: live `{type:'manifest'}` push (2026-09-07)

Each open WS connection now also subscribes to `client-manifest/changed`
(`packages/core`'s new event, fired on every `register`/effect-unregister —
see that package's README) and sends `{type:'manifest'}` — a signal frame,
carrying no payload — whenever it fires, disposed alongside the existing
`session/event` listener when the connection closes. This is what lets
`services/plugin-registry`'s enable/disable
(`POST /sessions/:id/plugins/:pluginId/enable`) reach an already-open browser
tab without a reconnect: it rewrites the session's `cordis.patch.yml` on
disk, `dsh`'s own `cordis-plugin-hmr` chokidar watcher disposes/creates the
affected plugin fiber, that fiber's `register()`/unregister fires the event,
and this listener turns it into a WS push. `apps/web` refetches
`GET /manifest` on receiving it (see that package's README) rather than this
transport trying to describe the diff itself. Full pipeline design and the
live-reload constraint that shaped it (a `disabled:` flip is the only thing
that can be live-applied — a brand-new `bundles` entry can't): docs/code-rules.md §20.

## Phase 6: telemetry (2026-09-07)

`ws_connect`/`ws_disconnect` now log as structured JSON (`{ts,
service:'transport', event, sessionId}`) — the worker-side leg of Phase 6
checklist item 2's cross-layer telemetry (`services/gateway` and
`services/orchestrator` are the other two; see
`services/orchestrator/README.md`'s Phase 6 section for the real
same-sessionId-across-all-three-logs test).

## Phase 11: real bug fix — third-party plugin `client.js` was never actually fetchable (2026-09-07)

**Pre-dates Phase 11 itself — a real gap that sat undiscovered since Phase
4, only surfaced once a plugin outside the `@fox-harness/*` scope actually
had its `client.js` fetched for real.** `GET /plugins/:id/client.js` used
plain `import.meta.resolve(`${id}/client`)` — real Node resolution, which
follows this file's own realpath (`/repo/packages/transport/lib/server.js`)
and walks up looking for `node_modules`. That only ever reaches
`/repo/node_modules/`, where `@fox-harness/*` packages ARE reachable
(`infra/docker/worker/entrypoint.sh` symlinks that scope in) — but never
`/data/profiles/fox-harness/node_modules/`, where every plugin-store plugin
(first-party test demos included) actually lives. Every prior "verified"
test only ever checked that `GET /manifest` LISTED such a plugin (proving
`ctx.clientManifest.register()` ran) — never that its `client.js` bytes
were actually fetchable. `resolveClientBundlePath()` now tries
`import.meta.resolve` first, and falls back to `createRequire()` anchored
at the profile's own `package.json` — the same idea
`@deepseek-ai/dsh-app-boot`'s real `resolveBundleDir`/`packageDirFromAnchor`
uses internally for its own bundle composition (confirmed by reading its
real installed source), just not exported for reuse. Full writeup, including
how this was found: docs/code-rules.md's Phase 11 entry.

## Phase 12: `slot` forwarded on `/manifest`, new `GET /plugin-inventory` route (2026-09-07)

`GET /manifest`'s entries now include `slot` (mirrors `packages/core`'s
`ClientManifestEntry.slot` verbatim) alongside `id`/`url`/`immediately` —
`apps/web`'s slots mechanism reads it to decide which outlet to mount into.

`GET /plugin-inventory` is new: real, live Cordis Loader state — iterates
`ctx.registry.entries()` (the actual installed `@deepseek-ai/cordis`
`RegistryService` API, `node_modules/@deepseek-ai/cordis/lib/types/{registry,fiber}.d.ts`,
not guessed), and for every registered plugin runtime's every live fiber
returns `{moduleName, entryId, state}` — `state` is `FiberState`'s numeric
`const enum` value mapped back to its name (`pending`/`loading`/`active`/
`failed`/`disposed`/`unloading`; the enum only exists as inlined numbers at
runtime, since `const enum` erases the name mapping). Backs
`packages/client-ui-plugin-inventory`, proxied session-scoped through
`services/gateway` the same way `/manifest`/`client.js` already are.

## NOT yet done / known gaps

- No auth at this layer — anyone who can reach the port can create sessions
  and read/write to them. Auth is `services/gateway`'s job — this package is
  meant to sit behind a gateway, never exposed directly.
- No backpressure/rate limiting on the WS connection.
- Multiple simultaneous connections to the *same* session (e.g. two browser
  tabs) aren't specifically tested — each gets its own `session/event`
  listener and its own snapshot, which should work, but hasn't been verified.
