# @fox-harness/dsh-tool-python-repl

Tool `python` for the data-analysis flow (`docs/rlm-transfer-plan.md`, giai đoạn 2).
Listed only in `packages/profile-template/data-analysis`.

- **One IPython process per worker container** (= one conversation), started on
  the first call in the session's working directory (`/data/workspace` for the
  data-analysis flow). Variables persist across calls and turns.
- **Protocol:** `src/kernel.ts` writes `{"code"}` lines to `python/runner.py`, which
  answers `{"ok", "output", "figures"}` lines. Tracebacks are part of `output`; a
  failed cell becomes a tool error.
- **Preloaded helpers** (`python/helpers.py`, adapted from agent-core's
  `rlm_agent/tools.py` without its upload index): `list_datasets()` (tabular
  files in the working directory, except `generated/` and hidden paths),
  `load_dataset(name=None)`, `profile_dataset(name=None)`,
  `save_artifact(path, content)` (writes under `generated/`).
- **Limits:** 120 s per call (then the process is killed and the model is told
  variables are gone), output truncated after 20 000 characters, `input()`
  raises.
- **Restart notice:** a `.python-session` marker in the working directory tells a
  fresh process (after hibernate or a crash) to prepend a "session was restarted"
  note to its first result.
- **Figures:** open matplotlib figures are saved to `generated/figure-*.png` and
  the paths are returned. The model does not see the image (the openai-compat
  adapter sends text only).
- **Environment:** the Python process gets `PATH`, `HOME`, `LANG` and
  `MPLBACKEND=Agg` only — never the worker's API keys. It runs inside the worker
  container without the bash tool's bwrap sandbox; the container is the
  isolation boundary.
- **Interpreter:** `FOX_PYTHON` (set in `infra/docker/worker/Dockerfile` to the
  image's venv), default `python3`.
