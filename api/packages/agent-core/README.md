# @fox-harness/dsh-agent-core

The core agent — one package, one program, serving every user's conversations from each runtime process. It is
three Cordis plugins (rows in `cordis.patch.yml`, loaded in this order):

| Plugin (subpath, row id) | Source | Does |
|---|---|---|
| `./policy` (`fox-harness-core`) | `src/policy/` | Per-agent model routing (`agent/request`: the session's model, else `OPENAI_MODEL_ID`, always `openai-compat`), the session token budget, the shared prompt sections (ground rules, operating policy, completion, environment/date). |
| `./loop` (`fox-harness-agent-loop`) | `src/loop/` | The agent loop (turn → steps → LLM call → tools), replacing dsh-base's `agent-loop` row (disabled). Same behaviour as dsh-agent-loop (`api/scripts/agent-loop-parity.mjs`), plus what one process serving many users needs: a scope per agent and the `setup` hook that joins a flow preset. |
| `./transport` (`fox-harness-transport`) | `src/transport/` | The runtime's entry point: a loopback WebSocket server the gateway relays each conversation to; creates or resumes the agent, joins its flow (`flows.ts`), snapshot-then-live events, idle disposal; and the workspace guard every agent's tool calls go through (`workspace-guard.ts`). |

Everything else — LLM adapters, tools, flow rules — plugs into this core from its own package. Overview of the whole
backend: `docs/core-architecture.md` at the repo root.

## Transport protocol (gateway ↔ runtime)

Loopback only, and every connection must carry the per-boot secret header `x-fox-harness-internal-secret` (refused
otherwise). One WebSocket connection = one conversation:

- `/sessions/new?id=<uuid>&…` creates it (`ctx.agents.create`); `/sessions/<id>?…` reopens it (`ctx.agents.resume`
  from the log, or the live agent).
- Query parameters, set by the gateway from the session row on **every** connect: `flow`, `model`, `cwd`
  (workspace), `user`, `role` (`admin`|`user`, default `user`), `output` (project output folder).
- A live conversation refuses a connect with a different `user` or `role` ("reconnect later").
- Server → client: `{type:'session', sessionId}` (new only), then `{type:'snapshot', events}` — the whole durable
  log — then `{type:'event', event}` per new event; `{type:'error', message}` on failure.
- Client → server: `{type:'followup', text}`, `{type:'steer', text}` (into the running turn), `{type:'cancel'}`.
  Frames are capped at 100 KB and text at 50,000 characters.

Snapshot-then-live rather than resume-from-cursor, as upstream's own browser transport: a reconnect is a fresh
connection with a fresh complete snapshot, which is simple to get right.

## Where the loop deliberately differs from dsh-agent-loop

- **Tool calls run one at a time** (upstream: in parallel, up to 10). Same results; slower only when the model asks
  for several tools in one step. Concurrent tool calls have never been exercised.
- **`fox/resolve-tool-call`**: a hook upstream does not have. A tool call naming an unknown tool can be rewritten
  by a plugin before execution — the `python` tool uses it to turn `list_datasets(...)` and friends, called as if
  they were tools, into a `python` call.
- `cancel()` and `resume()` are simpler than upstream's ownership/revision race handling: a stale reservation and an
  unknown session surface as the same rejection to the transport.

Everything else — request header/context bookkeeping, the runtime-context message, retry and overflow repair via
`agent/request-error` — follows upstream; `agent-loop-parity.mjs` checks every LLM request is identical.

History of how these pieces were built (phases, removed features): `docs/code-rules.md` and git history.
