# @fox-harness/dsh-agent-driver

Owns the entire turn/step flow, replacing `agent-loop` (roadmap §0.2, "nấc 2").
**Real implementation as of 2026-09-03** — `src/agent.ts` + `src/factory.ts`,
not a stub. Written by reading `@deepseek-ai/dsh-agent-loop`'s actual
TypeScript source (not guessed), then verified against the real installed
`.d.ts` files via `pnpm run typecheck` (clean) and a real local boot (clean —
`dsh --profile fox-harness` starts, serves `HTTP 200`, with this driver
active instead of the default).

## Verified end-to-end (2026-09-03) — Phase 1's own completion test, passed

A real chat turn ran through this driver against a real self-hosted model
(via `@fox-harness/dsh-llm-openai-compat`), driven by `dsh --profile
fox-harness-headless "..."` (CLI one-shot, no browser needed). The durable
session log (real, decompressed from `session.jsonl.zstd`) shows the exact
sequence this driver is supposed to produce: `turn/start → agent/inbox/spliced
→ step/start → user/message → assistant/chunk* (block-start reasoning →
reasoning deltas → block-start text → text deltas → block-end ×2 → usage →
finish) → assistant/message → step/end → turn/end (reason: completed)`. The
assembled `assistant/message.source` correctly shows
`{kind:'model', provider:'openai-compat', model:'hosted_vllm/...'}` — proving
the full chain (driver → `agent/request` waterfall → `dsh-core`'s env-based
override → `ctx.llm.prepareCall()` → our adapter → real HTTP → real model)
works together, not just each piece typechecking in isolation.

Getting here past the first "cannot get property... without inject" surfaced
**two more real bugs**, beyond the 5 in docs/code-rules.md §10 and the ones
below:

1. **`ownerCtx` (the caller-bound context `AgentFactory.createAgent()`
   receives) is not the same as this plugin's own `ctx`, and is not
   guaranteed to have the services this plugin needs injected.** `factory.ts`
   originally called `ownerCtx.sessions.prepare(...)` — worked fine on a
   plain server boot (nothing ever created an agent), but the first real
   `createAgent()` call (via headless — a plain web boot never exercises this
   without a real browser session) threw `cannot get property "sessions"
   without inject`, even though this plugin's own `inject` array already
   listed `sessions`. Fix: `FoxHarnessAgentLoop` now stores its own `ctx`
   (from `apply(ctx)`, where `inject` actually applies) and uses `this.ctx`
   for every service call — `session.prepare/enter/announce`,
   `agents.enter/announce`, and the `FoxHarnessAgent`'s own `.ctx` (which
   `runStep()` later reads `.systemPrompt`/`.llm`/`.tools` off of) — `ownerCtx`
   is kept only for `ownerCtx.agent` (parent-agent lookup for ownership).
2. **Swapping out `core/agent-loop` drops the reference implementation's own
   setup-time side effects too, not just its turn/step logic.** The real
   `dsh-agent-loop` registers three system-prompt template variables
   (`provider`, `model`, `cwd` — `packages/core/agent-loop/src/index.ts:421-423`
   in the real source). Without them, the shipped `system-prompt` row's
   persona template (`"...powered by the {{model}} model..."`) throws
   `unknown prompt variable "{{model}}"` the moment a real turn tries to
   assemble a prompt. Fix: `index.ts`'s `apply()` now registers the same
   three variables via `ctx.systemPrompt.variable(...)`.

Both are now folded into the code (`factory.ts`'s class doc comment, and
`index.ts`) — not just noted here.

## Deliberate scope cuts vs. the reference implementation (see `src/agent.ts`'s class doc comment for the full list)

- Tool calls execute sequentially, never in parallel.
- ~~`agent/request-error` isn't dispatched~~ — dispatched since 2026-09-14
  (docs/rlm-transfer-plan.md 0.2): enables `dsh-llm-retry` and
  `compaction-basic` overflow repair.
- ~~No `request/header`/`request/context`~~ — logged since 2026-09-14 (0.1),
  same rules as dsh-agent-loop's `buildRequest`.
- No `RuntimeContextProjection` — the reference injects a synthetic `user/message`
  describing current sandbox/approval policy state (source:
  `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt', form:'snapshot'}`)
  when that state is new/changed; this driver doesn't. Confirmed via a real
  side-by-side log diff (docs/code-rules.md §14) — the reference log had one
  extra `user/message` this driver's log didn't.
- `cancel()`/`runMaintenance()` are simpler than the reference's `FactoryOwnership` race handling.
- `resume()` (Phase 3, real now — see below) doesn't distinguish revision-stale
  reservation failures from a genuinely unknown session; both surface as one
  rejection to `packages/transport`'s caller.

None of these affect the durable event contract's correctness (docs/code-rules.md
§3) — they trade away concurrency/retry sophistication the reference has, not
correctness on the golden path. Both bookkeeping-event cuts above are now
confirmed, not just documented-by-intent — see the real log diff in
docs/code-rules.md §14.

## Verified facts (real installs, real source reads, real boots — not guessed)

- **`Agent` interface** (`@deepseek-ai/dsh-agent`'s `runtime-types.d.ts`): full
  member list is `id, options, session, inbox, status, ctx, cancel, whenIdle,
  runMaintenance, send, followup, steer, inject`. `followup`/`steer`/`inject`
  are one-line wrappers over `send()` with different `(target, wakeup)` pairs.
- **Durable events are plain `session.append(type, data, opts?)` calls** —
  not an event bus. `user/message`, `assistant/message`, `tool/result` are
  `SurfaceEventType`s and REQUIRE the third `opts: {surfaceOp}` argument or
  the compiler rejects the call; `turn/start`, `step/start`, `assistant/chunk`,
  `tool/call` etc. are non-surface and reject that argument.
- **Waterfall/serial dispatch reuses `agentEvents(ctx, this)`** from
  `@deepseek-ai/dsh-agent` — don't hand-roll `ctx.waterfall`/`ctx.serial`
  calls. Real events dispatched: `agent/pre-step` (waterfall), `agent/request`
  (waterfall), `agent/turn-stopping` (serial). `llm/stream` and the three
  `tools/*` waterfalls are NOT dispatched by the driver — they fire *inside*
  `preparedCall.stream()` and `ctx.tools.execute()` respectively.
- **Tool execution uses the PUBLIC `ctx.tools.execute(exec)`**, not the
  `@internal`-tagged `TOOL_RUNTIME_SCHEDULER` symbol the reference driver
  uses. `execute()`'s own doc comment says it runs "pre-policy, guards,
  around-dispatch, post-policy, ... final notification" — i.e. it already
  fires the `tools/*` waterfalls internally. Using the internal scheduler
  symbol is reserved for the reference's own parallel-dispatch machinery;
  the public method is the right seam for a custom driver (roadmap's own
  "plugins, not loop internals" convention).
- **`session.deriveMessages()`** (a method on `Session` from `dsh-session`)
  is the real `deriveMessages()` roadmap §0.4 refers to — call it directly,
  don't reimplement log→message projection.
- **The real row id patched is `agent-loop`** (not `core/agent-loop`), and
  patching it correctly requires TWO patch entries, not one — see
  `cordis.patch.yml`'s comment for the two real errors (`duplicate loader
  entry id`, then `name mismatch... skipping`) that led to the disable+insert
  shape.
- **A plain `apply(ctx)` plugin function still needs `export const inject = [...]`**
  to touch a named context service (`ctx.agents`) — this isn't only a
  `Service`-subclass requirement. Confirmed by a real boot error: `cannot get
  property "agents" without inject`.

## Phase 1: all 3 completion criteria met (2026-09-03)

Roadmap's Phase 1 test: *"`dsh --profile <your>` chạy được một session
end-to-end với driver của bạn, log tương thích, tool hoạt động."* All three
now have real evidence, not just plausible-looking code:

- **Session end-to-end** — real chat turns via `dsh --profile
  fox-harness-headless`, real self-hosted model, real replies.
- **Tool hoạt động** — a real forced tool call
  (`@fox-harness/dsh-tool-duckduckgo-web-search`) produced real search results
  through this driver's `tool/call`→`tool/result` handling.
- **Log tương thích** — a real side-by-side diff against the unmodified
  `dsh-agent-loop` (same prompt, parallel runs, a separate `fox-harness-baseline`
  profile) confirms the core turn/step event contract is identical; the only
  differences are the two documented scope cuts above, now confirmed by data
  instead of by intent. Full writeup: docs/code-rules.md §14.

## Phase 3: `resume()` implemented, and a real data-loss bug fixed (2026-09-04)

`resume()` was the very first thing Phase 3 needed — before any Docker/Redis
work, a fresh container has no way to load a session back off disk without
it. Real API (confirmed via installed `.d.ts`, not guessed):
`ctx.sessionPersistence.prepare(id, signal?): Promise<SessionPreparation>` —
`.session` is already a ready-to-publish `Session`, reused directly by
`enterAndAnnounce()` (the same path `createAgent()` uses). `SessionPreparation`
implements `Disposable`; `factory.ts` calls `preparation[Symbol.dispose]()` in
a `finally` (its own doc comment: disposal is a no-op once publication
consumed it, but matters on the rollback path). `ResumeAgentOptions`'s session
id field is `resumeSessionId`, not `sessionId` — different name than
`CreateAgentOptions`.

**One real data-loss bug found and fixed, and it's the whole reason Phase 3's
kill-9 test exists.** `@deepseek-ai/dsh-session-checkpoint-policy`'s own doc
comment: it checkpoints a response/result batch at "the next request
boundary" — lazily, deferred to a FOLLOWING turn. A session's most recent
turn, with no follow-up yet, was genuinely unflushed on disk, even though
`session/event` had already notified live subscribers (that event fires
post-*commit*, not post-*flush* — two different guarantees). A hard kill
right after loses it. `dsh-headless`'s real source hits the same gap and
explicitly does `await agent.whenIdle(); await sessions.flush(agent.session)`
before exiting. Fix: `agent.ts`'s `wake()` now does the same
(`ctx.sessions.flush(this.session)`) right after `drive()` returns, before
resolving `idleWaiters` — every driver instance gets this for free instead of
depending on each `whenIdle()` caller to remember it. Confirmed fixed with
real data: see docs/code-rules.md §17 and `services/orchestrator/README.md`.

## TODO

- [ ] Add `@deepseek-ai/dsh-session` (or `dsh-llm`) as a *direct* devDependency
      (currently transitive) now that `agent.ts` actually imports `UserMessage`/
      `Session`/`TurnEndReason` from it.
- [ ] Exercise a tool-call turn with *concurrent* tool calls — every real test
      so far (this driver executes tools sequentially by design) has been a
      single tool call per step.
