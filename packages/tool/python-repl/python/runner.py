"""JSON-lines IPython runner for the `python` tool (packages/tool/python-repl).

stdin:  one {"code": "..."} per line.
stdout: one {"ok": bool, "output": str, "figures": [path, ...]} per line.
Everything the cell prints (including tracebacks) is captured into "output".
"""

import builtins
import contextlib
import io
import json
import os
import sys
import time

from IPython.core.interactiveshell import InteractiveShell

protocol_out = sys.stdout
shell = InteractiveShell.instance()
shell.run_line_magic("colors", "nocolor")

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "helpers.py")
with open(HELPERS, encoding="utf-8") as helpers_file:
    exec(compile(helpers_file.read(), HELPERS, "exec"), shell.user_ns)


def _no_input(*_args, **_kwargs):
    raise RuntimeError("input() is not available: stdin carries the tool protocol")


builtins.input = _no_input


# generated/ for a chat of its own; generated/<chat id> in a shared project folder.
OUTPUT_DIR = os.environ.get("FOX_OUTPUT_DIR", "generated")


def save_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None or not plt.get_fignums():
        return []
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    paths = []
    for number in plt.get_fignums():
        path = os.path.join(OUTPUT_DIR, f"figure-{int(time.time() * 1000)}-{number}.png")
        plt.figure(number).savefig(path, dpi=110, bbox_inches="tight")
        paths.append(path)
    plt.close("all")
    return paths


for line in sys.stdin:
    request = json.loads(line)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
        result = shell.run_cell(request["code"], store_history=True)
        figures = save_figures()
    print(json.dumps({"ok": result.success, "output": buffer.getvalue(), "figures": figures}), file=protocol_out, flush=True)
