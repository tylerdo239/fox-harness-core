# @fox-harness/dsh-agent-core

The core agent — one package, one program, serving every user's conversations from each runtime process. It is
three Cordis plugins (rows in `cordis.patch.yml`, loaded in this order):

| Plugin (subpath, row id) | Source | Does |
|---|---|---|
| `./policy` (`fox-harness-core`) | `src/policy/` | Per-agent model routing (`agent/request`: the session's model, else `OPENAI_MODEL_ID`, always `openai-compat`), the session token budget, the shared prompt sections (ground rules, operating policy, completion, environment/date). |
| `./loop` (`fox-harness-agent-loop`) | `src/loop/` | The agent loop (turn → steps → LLM call → tools), replacing dsh-base's `agent-loop` row (disabled). Same behaviour as dsh-agent-loop (`api/scripts/agent-loop-parity.mjs`), plus what one process serving many users needs: a scope per agent and the `setup` hook that joins a flow preset. Tool calls run one at a time. |
| `./transport` (`fox-harness-transport`) | `src/transport/` | The runtime's entry point: a loopback WebSocket server (internal secret required) the gateway relays each conversation to; creates or resumes the agent, joins its flow (`flows.ts`), snapshot-then-live events, idle disposal; and the workspace guard every agent's tool calls go through. |

Everything else — LLM adapters, tools, flow rules — plugs into this core from its own package. Design notes from
when these were three packages: `docs/loop.md`, `docs/policy.md`, `docs/transport.md`. Overview of the whole
backend: `docs/core-architecture.md` at the repo root.
