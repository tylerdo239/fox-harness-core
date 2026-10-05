# @fox-harness/dsh-tool-python-repl

Tool `python` for the data-analysis flow (`docs/rlm-transfer-plan.md`, giai đoạn 2).
Listed only in `packages/profile-template/data-analysis`.

- **One IPython process per worker container** (= one conversation), started on
  the first call in the session's working directory (`/data/workspace` for the
  data-analysis flow). Variables persist across calls and turns.
- **Protocol:** `src/kernel.ts` writes `{"code"}` lines to `python/runner.py`, which
  answers `{"ok", "output", "figures", "variables"}` lines. Tracebacks are part of
  `output`; a failed cell becomes a tool error. While a cell runs, the runner may
  write a `{"host": {...}}` line instead; the kernel answers it on stdin with
  `{"result"}` or `{"error"}` (bridge after agent-core's loop-rlm `worker.py`).
- **Variables note** (`docs/rlm-transfer-plan.md` 12.3 B): after each cell the
  runner lists the model's data variables (`DataFrame 611×6 — date, region, …`).
  An `agent/pre-step` listener adds them as a user-role note whenever the text
  differs from the latest note still on the model-visible surface — the algorithm
  of dsh-agent-loop's `RuntimeContextProjection` — placed right after the step's own
  messages, so another plugin's note (the step-limit wrap-up) stays the last one. When the process is gone after
  earlier Python use, the note says variables are gone.
- **`history(n)`** (12.3): turn `n` of the conversation (user message, code,
  outputs, answer) rebuilt from the session's original events through the host
  bridge — no file is written, so a turn collapsed or compacted for the model still
  reads in full.
- **Preloaded helpers** (`python/helpers.py`, adapted from agent-core's
  `rlm_agent/tools.py`): `list_datasets()` (the uploads the orchestrator records in
  `.fox/sources.json`, shared `outputs/` and this chat's own output folder — never
  another chat's files; without that record, tabular files outside `generated/`
  and hidden paths),
  `load_dataset(name=None)`, `profile_dataset(name=None)`,
  `save_artifact(path, content)` (writes under `generated/`), `history(n)`.
- **Limits:** 120 s per call (then the process is killed and the model is told
  variables are gone), output past 20 000 characters keeps its first 14 000 and
  last 6 000 (a traceback printed last stays visible), `input()` raises.
- **Restart notice:** a `.python-session` marker in the working directory tells a
  fresh process (after hibernate or a crash) to prepend a "session was restarted"
  note to its first result.
- **Figures:** matplotlib figures still open after a successful call are saved to
  the output folder as `figure-*.png` and the paths are returned — not after a
  failed call, and not figures the code already saved itself (`savefig`). A figure
  that cannot be saved is reported in the output instead of ending the process.
- **Stray files:** files a call writes into the working directory itself (not
  uploads recorded in `.fox/sources.json`, `generated/`, `outputs/` or hidden paths)
  are moved to the chat's output folder afterwards, and the output names the new
  paths — so in a project they never sit among the sources.
  The model does not see the image (the openai-compat adapter sends text only).
- **Environment:** the Python process gets `PATH`, `HOME`, `LANG` and
  `MPLBACKEND=Agg` only — never the worker's API keys. It runs inside the worker
  container without the bash tool's bwrap sandbox; the container is the
  isolation boundary.
- **Interpreter:** `FOX_PYTHON` (set in `infra/docker/worker/Dockerfile` to the
  image's venv), default `python3`.
