# @fox-harness/dsh-tool-data-studio-agent

Tool `analyze_data` (`docs/data-studio-agent-transfer-plan.md`). Listed in the
default profile (`packages/profile-template/default`) — available to every
session, not gated behind a flow.

- **The Python pipeline (`pipeline_v3`/`pipeline_v2`, semantic layer) is
  vendored, not rewritten.** `packages/tool/data-studio-agent/python` is a copy of
  `example-data-studio-agent`'s backend logic. This package contains ZERO
  business logic — it is a thin subprocess bridge, same shape as
  `@fox-harness/dsh-tool-python-repl`.
- **The vendored FastAPI/HTTP/auth layer was deleted, not just unused** —
  `src/apis/`, `src/app.py`, `main.py`, `src/security.py`,
  `src/services/dashboard_pdf.py` and their `fastapi`/`uvicorn`/`python-jose`/
  `weasyprint` dependencies are gone (confirmed via import-graph grep before
  deleting: nothing `pipeline_v3`/`pipeline_v2` needs was in there). Only
  `bridge/runner.py`, which calls `run_pipeline_v3` in-process, remains as the
  entry point.
- **One persistent process per worker container**, started on the first call,
  reused across turns. **Protocol:** `src/kernel.ts` writes `{"question"}`
  lines to `packages/tool/data-studio-agent/python/bridge/runner.py`, which answers one
  JSON line: `{"ok", "answer", "sql", "columns", "rows", "row_count",
  "trace_md", "chart", "truncated"}` or `{"ok": false, "error"}`.
- **Stateless per call** — `run_pipeline_v3` takes no conversation history;
  fox's own session log carries multi-turn context, so each question is
  independent on the Python side.
- **Shared semantic layer:** the pipeline's SQLite config DB
  (data sources/entities/metrics/glossary) is NOT per-session — every worker
  container mounts the same host directory at a fixed path
  (`services/orchestrator/src/docker.ts`'s `dataStudioSharedDir` bind,
  `DATABASE_URL` env), unlike the per-session `/data` mount every other tool
  uses.
- **Interpreter:** `FOX_PYTHON_DATA_STUDIO`, a SEPARATE venv from
  `python-repl`'s `/opt/fox-py` (`infra/docker/worker/Dockerfile` runs
  `uv sync --locked` inside `packages/tool/data-studio-agent/python` — that project pins
  Python ≥3.12, which the base image's own apt python3 doesn't provide).
- **Environment:** unlike `python-repl` (model-written code, minimal env), this
  subprocess runs our own vetted script and needs real credentials —
  `OPENAI_*`/`EMBEDDING_*`/`DREMIO_*`/`MEILISEARCH_*`/`DATABASE_URL` are
  forwarded from the worker container's own env (see `src/kernel.ts`'s
  `FORWARDED_ENV`).
- **Known limitation:** the vendored pipeline's per-chart vision review
  normally waits for a frontend to render + screenshot the chart; with no
  frontend attached each chart review times out after 12s and falls back to
  the un-reviewed chart (bounded, not a hang — see `bridge/runner.py`'s
  docstring).
