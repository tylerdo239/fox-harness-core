# @fox-harness/dsh-llm-openai-compat

Generic OpenAI-compatible chat-completions `LlmAdapter`, registered through
`ctx.llm.registerAdapter()` — the same seam `@deepseek-ai/dsh-llm-deepseek`
uses. Works against real OpenAI, Azure OpenAI, and most self-hosted servers
that speak the same `/chat/completions` SSE protocol (Ollama, vLLM, LM
Studio, OpenRouter, ...).

This is a pure addition, not a replacement of anything — "nấc 2" only asks
you to swap what you actually need to swap (roadmap §0.2); the default
`llm`/`llm-deepseek` rows stay untouched. Use this alongside them (register
under a different `provider` route) or instead of them, by configuring
`agent-default-model`'s `provider` to point here.

## Written by reading the real reference adapter's source (2026-09-03)

`@deepseek-ai/dsh-llm-deepseek`'s actual TypeScript source was read directly
(not guessed) to get the dsh-specific integration points right: how
`ctx.llm.registerAdapter()` is called, the `Config`-as-Schemastery-schema
convention (`export const Config: z<Config>` alongside `export interface
Config`, validated by Cordis before `apply(ctx, config)` runs), the real
credential-resolution path (`ctx.get('credentials')` → optional service →
`credentials.resolve(credentialRef(...))`, falling back to
`launchEnvironmentOf(ctx).get(ref)`), and the fact that `LlmAdapter.stream()`
does **not** need its own try/catch — `LlmRuntime.stream()` (the `ctx.llm`
service wrapping this adapter) normalizes any thrown error into a terminal
`error`/`aborted` finish chunk on its own.

The actual OpenAI wire-format translation (`serialize.ts`, `translate.ts`)
was written directly against the well-known OpenAI chat-completions
request/SSE-response shape — not copied from DeepSeek's adapter, since
DeepSeek's own protocol carries DeepSeek-specific extras (Files API,
image-upload quotas, custom `x-deepseek-harness-*` headers) that don't belong
in a generic adapter. `sse.ts` (the `eventsource-parser`-based SSE frame
reader) *is* near-verbatim from the reference — that part isn't
provider-specific.

## Verified (real boot + real request, 2026-09-03)

- Package structurally loads: no import errors, `Config` schema validates
  correctly (confirmed by first triggering the *expected* failure — booting
  with `config: {}` throws a clean `$.baseURL missing required value`
  validation error — then supplying a real `baseURL`/`apiKeyEnv` via the
  profile's `cordis.patch.yml` overlay and booting clean).
- `pnpm run typecheck` clean against real installed `@deepseek-ai/dsh-llm`
  types (`LlmAdapter`, `StreamChunk`, `GenerateOptions`, `FinishReason` are
  all the real types, not placeholders).
- **A real request against a real self-hosted OpenAI-compatible endpoint
  (a reasoning model) round-tripped correctly**, exercising `serialize.ts` →
  `fetch` → `sse.ts` → `translate.ts` end to end (tested standalone, bypassing
  Cordis boot — the credential-resolution plumbing is separately verified via
  the real-boot pass above). Confirmed correct: `block-start`/`*-delta`/
  `block-end` sequencing across TWO block kinds in one response (the model
  streamed a `reasoning` block via `delta.reasoning_content`, closed it, then
  opened a `text` block for the final answer — proving the multi-block index
  tracking in `translate.ts` is not just typechecked but behaviorally
  correct), a correctly-shaped terminal `usage` chunk, and `finish: {kind:
  'stop'}` mapped from the wire's `finish_reason`. Final assembled text
  matched the model's actual reply.

## Verified through the real turn/step driver too (2026-09-03)

Ran a real chat turn via `dsh --profile fox-harness-headless "..."` (our
`agent-driver` + `dsh-core`'s env-based routing + this adapter, all together,
no mocking). The real session log confirms `resolveApiKey()` and
`resolveBaseURL()` both resolved correctly from the launch environment (no
`baseURL`/`apiKeyEnv` set in any patch file — pure `OPENAI_API_KEY`/
`OPENAI_BASE_URL`/`OPENAI_MODEL_ID` env vars), and `assistant/message.source`
shows the exact configured `provider`/`model`. See
`packages/agent-driver/README.md`'s "Verified end-to-end" section for the
full log excerpt.

## NOT verified

- Tool-call streaming (`tool-call-delta`/multi-concurrent-tool-call index
  tracking) has not been exercised by a real response yet — every real test
  so far has been a plain text/reasoning reply, no tool calls.
- `providerInfo()` / `listModels()` / `resolveModel()` all use `LlmAdapter`'s
  base-class defaults — not overridden, so model discovery/display metadata
  is generic, not provider-specific.

## Configure

Two ways, pick one:

**Env vars only (recommended — "dễ kiểm soát", no patch file to edit):**

```
OPENAI_API_KEY=...           # apiKeyEnv defaults to this name already
OPENAI_BASE_URL=https://your-endpoint/v1
OPENAI_MODEL_ID=your/model-id
```

`baseURL` falls back to `OPENAI_BASE_URL` (`adapter.ts`'s `resolveBaseURL()`)
when not set in config; `@fox-harness/dsh-core`'s `agent/request` listener
routes `provider`/`model` from `OPENAI_MODEL_ID` automatically.

**Explicit patch config (still supported, e.g. for a second provider alongside env-driven default):**

```yaml
# a profile's own cordis.patch.yml, or a per-user patch
- id: fox-harness-llm-openai-compat
  name: '@fox-harness/dsh-llm-openai-compat'
  config:
    provider: openai-compat       # GenerateOptions.provider route
    baseURL: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY     # or any self-hosted server's own key env var
```

Then point `agent-default-model`'s `provider`/`model` at this route (or
whatever selects a model per-agent) to actually use it for chat.

## TODO

- [x] ~~Run a real chat turn through the actual `agent-driver`~~ — done
      2026-09-03 via `dsh --profile fox-harness-headless`.
- [ ] Exercise a tool-call response for real — every real test so far has
      been a plain text/reasoning reply, no tool calls.
- [ ] Consider overriding `listModels()`/`resolveModel()` once a real target
      server's model-listing endpoint (or static `config.models` list) is
      worth surfacing in UI.
