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
import numbers
import os
import sys
import time
import types

from IPython.core.interactiveshell import InteractiveShell

protocol_out = sys.stdout
shell = InteractiveShell.instance()
shell.run_line_magic("colors", "nocolor")

def _fox_host(request):
    # Bridge after agent-core's loop-rlm/python/worker.py (host_tool_call, await_host_reply):
    # the worker writes its answer to stdin, which is idle while a cell runs.
    print(json.dumps({"host": request}), file=protocol_out, flush=True)
    answer = json.loads(sys.stdin.readline())
    if "error" in answer:
        raise RuntimeError(answer["error"])
    return answer["result"]


# helpers.py is loaded as a REAL module and then published into the session, so
# both ways of reaching it work. The model regularly writes
# `from helpers import list_datasets` (docs/qa-report-2026-09-15.md V6) and used
# to get "No module named 'helper'" — a session that has these functions ready
# should let an import of them succeed instead of failing on a technicality.
# Registered under both spellings because the model uses both.
HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "helpers.py")
helpers = types.ModuleType("helpers")
helpers.__file__ = HELPERS
helpers.__dict__["_fox_host"] = _fox_host
with open(HELPERS, encoding="utf-8") as helpers_file:
    exec(compile(helpers_file.read(), HELPERS, "exec"), helpers.__dict__)
sys.modules["helpers"] = helpers
sys.modules["helper"] = helpers
shell.user_ns.update({name: value for name, value in helpers.__dict__.items() if not name.startswith("__")})


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
helpers.patch_pandas_readers()


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


def move_stray_files():
    """Move files a cell wrote into the working directory to this chat's output folder — not
    uploads (.fox/sources.json), another chat's generated/<id>/ folder, outputs/ or hidden paths —
    so a chat's files never sit among a project's sources (docs/qa-report-2026-09-15.md N2).
    Returns [(old path, new path)]. The end-of-turn reconciliation in
    @fox-harness/dsh-flow-data-analysis covers what this cannot see: other tools, and files left
    by a cell that was killed. This one exists for the path it reports back inside the same cell."""
    try:
        with open(os.path.join(".fox", "sources.json"), encoding="utf-8") as sources_file:
            sources = set(json.load(sources_file))
    except (OSError, ValueError):
        sources = set()
    moved = []
    for folder, dirs, files in os.walk("."):
        if folder == ".":
            # generated/ IS walked, unlike outputs/: a file written straight into it (the folder
            # name the model is taught by save_artifact's description) belongs to no chat, and the
            # UI then shows it in every chat of the project. Only the per-chat folders inside it
            # are left alone.
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "outputs"]
        elif folder == os.path.join(".", "generated"):
            dirs[:] = []
        else:
            dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            path = os.path.normpath(os.path.join(folder, name))
            posix = path.replace(os.sep, "/")
            # No "written since this cell started" test: a file's mtime comes from the kernel's
            # coarse clock and measured a millisecond EARLIER than the time.time() taken just
            # before writing it, so that test dropped files written in a cell's first few
            # milliseconds. Ownership decides instead, the same rule the end-of-turn
            # reconciliation uses: not an upload, not shared, not another chat's — so it is ours.
            if name.startswith(".") or posix in sources:
                continue
            inside = posix[len("generated/"):] if posix.startswith("generated/") else path
            target = os.path.join(OUTPUT_DIR, inside)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.replace(path, target)
            moved.append((posix, target.replace(os.sep, "/")))
    return moved


# Names that exist before any model code runs (IPython's own, the helpers and their
# imports) are not the model's variables.
BASE_NAMES = set(shell.user_ns)


# How many characters of a DataFrame's column list the variables note may carry.
COLUMN_NOTE_CHARS = 400


def _empty_warning(value):
    """Flag on a frame/series the model is about to draw a conclusion from.

    An empty result or an all-missing column is what produced the worst answer this harness has
    given: "every region fell 100%", stated with no doubt at all (docs/qa-report-2026-09-15.md N6).
    The harness is describing the variable anyway — saying that it is empty costs nothing and is a
    fact about the data, not advice. Only the two unambiguous cases are flagged.
    """
    rows = value.shape[0]
    if rows == 0:
        return "  ⚠ no rows"
    if getattr(value, "ndim", 1) == 1:
        return "  ⚠ every value is missing" if value.isna().all() else ""
    # One pass over a large frame per cell is not worth it; the small ones are where analysis happens.
    if value.size > 2_000_000:
        return ""
    empty = [str(column) for column in value.columns if value[column].isna().all()]
    if not empty:
        return ""
    shown = ", ".join(empty[:4]) + (f", +{len(empty) - 4}" if len(empty) > 4 else "")
    return f"  ⚠ every value is missing in {shown}"


def describe(value):
    """One-line summary for the variables note (docs/rlm-transfer-plan.md 12.3 B, RLM's SHOW_VARS)."""
    kind = type(value).__name__
    if kind == "DataFrame":
        columns = [str(column) for column in value.columns]
        warning = _empty_warning(value)
        # Every column name the model might reference, up to a budget: a truncated
        # list made it guess names that were not there (qa-report V6).
        shown, budget = [], COLUMN_NOTE_CHARS
        for column in columns:
            if budget - len(column) < 0 and shown:
                break
            shown.append(column)
            budget -= len(column) + 2
        rest = f", … (+{len(columns) - len(shown)} cột nữa)" if len(shown) < len(columns) else ""
        return f"DataFrame {value.shape[0]}×{value.shape[1]} — {', '.join(shown)}{rest}{warning}"
    if kind == "Series":
        return f"Series {len(value)} ({value.dtype}){_empty_warning(value)}"
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


def scalar_result(result, code):
    """[label, value] when the cell ended in a single number or a short string, else None.

    The ledger this feeds (kernel.ts) exists because a number computed in turn 3 disappears when
    that turn's tool steps are collapsed or compacted, and the model then restates it from memory.
    `print(history(n))` is offered at exactly that moment and was taken 0 times in 820 stored
    conversations — so the values are pushed back in instead of waiting to be fetched.
    """
    value = getattr(result, "result", None)
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, numbers.Number):
        text = f"{float(value):.6g}" if isinstance(value, float) or hasattr(value, "dtype") else str(value)
    elif isinstance(value, str) and len(value) <= 80:
        text = value
    else:
        return None
    lines = [line.strip() for line in code.splitlines() if line.strip() and not line.strip().startswith("#")]
    label = lines[-1] if lines else ""
    return [label[:80], text.strip()]


seen = {}
for line in iter(sys.stdin.readline, ""):
    request = json.loads(line)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
        result = shell.run_cell(request["code"], store_history=True)
        figures = save_figures(result.success)
        moved = move_stray_files()
    if moved:
        print(
            "Files written into the working directory were moved to this chat's output folder — use the new paths: "
            + ", ".join(f"{old} → {new}" for old, new in moved),
            file=buffer,
        )
    listed, seen = variables(seen)
    reply = {"ok": result.success, "output": buffer.getvalue(), "figures": figures, "variables": listed}
    if result.success:
        computed = scalar_result(result, request["code"])
        if computed is not None:
            reply["result"] = computed
    print(json.dumps(reply), file=protocol_out, flush=True)
