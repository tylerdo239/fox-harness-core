"""JSON-lines IPython runner for the `python` tool (packages/tool/python-repl).

stdin:  one {"code": "..."} per line; while a cell runs, the answer to its host request.
stdout: one {"ok": bool, "output": str, "figures": [path, ...], "variables": [[name, description, changed], ...]}
        per cell, or {"host": {...}} — a running cell asking the worker for data only it holds (history()).
Everything the cell prints (including tracebacks) is captured into "output".
"""

import builtins
import contextlib
import io
import json
import os
import sys
import time
import types

from IPython.core.interactiveshell import InteractiveShell

protocol_out = sys.stdout
shell = InteractiveShell.instance()
shell.run_line_magic("colors", "nocolor")

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "helpers.py")
with open(HELPERS, encoding="utf-8") as helpers_file:
    exec(compile(helpers_file.read(), HELPERS, "exec"), shell.user_ns)


def _fox_host(request):
    # Bridge after agent-core's loop-rlm/python/worker.py (host_tool_call, await_host_reply):
    # the worker writes its answer to stdin, which is idle while a cell runs.
    print(json.dumps({"host": request}), file=protocol_out, flush=True)
    answer = json.loads(sys.stdin.readline())
    if "error" in answer:
        raise RuntimeError(answer["error"])
    return answer["result"]


shell.user_ns["_fox_host"] = _fox_host


def _no_input(*_args, **_kwargs):
    raise RuntimeError("input() is not available: stdin carries the tool protocol")


builtins.input = _no_input


# generated/ for a chat of its own; generated/<chat id> in a shared project folder.
OUTPUT_DIR = os.environ.get("FOX_OUTPUT_DIR", "generated")


def mark_saved_figures():
    """Flag figures the code saves itself (plt.savefig, fig.savefig) so they are not saved twice."""
    try:
        from matplotlib.figure import Figure
    except ImportError:
        return
    original = Figure.savefig

    def savefig(self, *args, **kwargs):
        self._fox_saved = True
        return original(self, *args, **kwargs)

    Figure.savefig = savefig


mark_saved_figures()


def save_figures(cell_succeeded):
    """Save the figures still open after a cell — not after a failed cell, nor ones already saved — and close them."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None or not plt.get_fignums():
        return []
    paths = []
    for number in plt.get_fignums():
        if not cell_succeeded or getattr(plt.figure(number), "_fox_saved", False):
            continue
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        path = os.path.join(OUTPUT_DIR, f"figure-{int(time.time() * 1000)}-{number}.png")
        # A figure the cell itself could not save (e.g. a label placed far off the
        # axes) fails here too: report it next to the cell's own error instead of
        # ending the Python process and losing that error.
        try:
            plt.figure(number).savefig(path, dpi=110, bbox_inches="tight")
            paths.append(path)
        except Exception as error:
            print(f"Figure {number} was not saved: {type(error).__name__}: {error}")
    plt.close("all")
    return paths


def move_stray_files(since):
    """Move files a cell wrote into the working directory to the output folder — not uploads
    (.fox/sources.json), generated/, outputs/ or hidden paths — so a chat's files never sit among
    a project's sources (docs/qa-report-2026-09-15.md N2). Returns [(old path, new path)]."""
    try:
        with open(os.path.join(".fox", "sources.json"), encoding="utf-8") as sources_file:
            sources = set(json.load(sources_file))
    except (OSError, ValueError):
        sources = set()
    moved = []
    for folder, dirs, files in os.walk("."):
        top = folder == "."
        dirs[:] = [d for d in dirs if not d.startswith(".") and not (top and d in ("generated", "outputs"))]
        for name in files:
            path = os.path.normpath(os.path.join(folder, name))
            posix = path.replace(os.sep, "/")
            if name.startswith(".") or posix in sources or os.path.getmtime(path) < since:
                continue
            target = os.path.join(OUTPUT_DIR, path)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.replace(path, target)
            moved.append((posix, target.replace(os.sep, "/")))
    return moved


# Names that exist before any model code runs (IPython's own, the helpers and their
# imports) are not the model's variables.
BASE_NAMES = set(shell.user_ns)


def describe(value):
    """One-line summary for the variables note (docs/rlm-transfer-plan.md 12.3 B, RLM's SHOW_VARS)."""
    kind = type(value).__name__
    if kind == "DataFrame":
        columns = [str(column) for column in value.columns]
        shown = ", ".join(columns[:8]) + (f", … (+{len(columns) - 8})" if len(columns) > 8 else "")
        return f"DataFrame {value.shape[0]}×{value.shape[1]} — {shown}"
    if kind == "Series":
        return f"Series {len(value)} ({value.dtype})"
    if isinstance(getattr(value, "shape", None), tuple):
        return f"{kind} {value.shape} {getattr(value, 'dtype', '')}".rstrip()
    if isinstance(value, (list, tuple, set, dict)):
        return f"{kind} {len(value)}"
    text = repr(value) if isinstance(value, (bool, int, float, str)) else kind
    return text if len(text) <= 60 else text[:57] + "..."


def variables(previous):
    """[name, description, changed] for the model's data variables; `previous` maps name to (id, description)."""
    listed, current = [], {}
    for name, value in list(shell.user_ns.items()):
        if name.startswith("_") or name in BASE_NAMES or callable(value) or isinstance(value, types.ModuleType):
            continue
        try:
            description = describe(value)
        except Exception:  # an object whose shape or len raises must not end the session
            description = type(value).__name__
        current[name] = (id(value), description)
        listed.append([name, description, previous.get(name) != current[name]])
    return listed, current


seen = {}
for line in iter(sys.stdin.readline, ""):
    request = json.loads(line)
    buffer = io.StringIO()
    started = time.time()
    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
        result = shell.run_cell(request["code"], store_history=True)
        figures = save_figures(result.success)
        moved = move_stray_files(started)
    if moved:
        print(
            "Files written into the working directory were moved to this chat's output folder — use the new paths: "
            + ", ".join(f"{old} → {new}" for old, new in moved),
            file=buffer,
        )
    listed, seen = variables(seen)
    reply = {"ok": result.success, "output": buffer.getvalue(), "figures": figures, "variables": listed}
    print(json.dumps(reply), file=protocol_out, flush=True)
