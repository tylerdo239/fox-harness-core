"""Data helpers preloaded into the `python` tool's IPython session.

Datasets are the tabular files the user uploaded (listed by the orchestrator in
.fox/sources.json), outputs shared in the project (outputs/) and this chat's own
outputs; without that list, every tabular file outside generated/ and hidden
paths. Adapted from agent-core's bundles/loop-drivers/loop-rlm/python/rlm_agent/tools.py,
without its per-conversation draft folders.
"""

import json
import os
from pathlib import Path

# Imported here, at module level, so `pd`/`np`/`plt` are BOUND IN THE MODEL'S
# SESSION: runner.py execs this file into the IPython namespace, so a name that
# is only imported inside a function (as pandas was until 2026-09-16) does not
# exist for the model's own code. It got a pandas DataFrame back from
# load_dataset() and then failed on `pd.to_datetime(...)` with "name 'pd' is not
# defined" (docs/qa-report-2026-09-15.md V6, 2/2 runs of a six-question chain).
# A data-analysis session that hands out DataFrames must have pandas bound.
# Matplotlib is safe to import at start-up: kernel.ts spawns this process with
# MPLBACKEND=Agg, so no display is ever needed.
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

_DATASET_SUFFIXES = {".csv", ".tsv", ".xlsx", ".xls", ".parquet"}
# generated/ for a chat of its own; generated/<chat id> in a shared project folder.
_OUTPUT_DIR = os.environ.get("FOX_OUTPUT_DIR", "generated")
_dataset_cache = {}
_sheet_cache = {}


def _working_path(relative_path):
    root = Path.cwd().resolve()
    target = (root / str(relative_path)).resolve()
    if target != root and root not in target.parents:
        raise ValueError("path escapes the working directory")
    return target


def _sources(root):
    """Paths of the files the user uploaded, or None when the orchestrator has not recorded them."""
    try:
        return set(json.loads((root / ".fox" / "sources.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def list_datasets():
    """Tabular files to analyse, newest first: uploads, shared outputs and this chat's own outputs."""
    root = Path.cwd()
    sources = _sources(root)
    own = Path(_OUTPUT_DIR)
    items = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if not path.is_file() or path.suffix.lower() not in _DATASET_SUFFIXES:
            continue
        if any(part.startswith(".") for part in relative.parts):
            continue
        if sources is None:
            if relative.parts[0] == "generated":
                continue
        elif not (relative.as_posix() in sources or relative.parts[0] == "outputs" or relative.is_relative_to(own)):
            continue
        stat = path.stat()
        for sheet in _sheets(path)[1:]:
            items.append({"name": f"{relative.as_posix()}#{sheet}", "size_bytes": stat.st_size, "modified": stat.st_mtime})
        items.append({"name": relative.as_posix(), "size_bytes": stat.st_size, "modified": stat.st_mtime})
    return sorted(items, key=lambda item: item["modified"], reverse=True)


def _sheets(path):
    """Sheet names of an Excel workbook, empty for anything else. Cached per (path, mtime)."""
    if path.suffix.lower() not in {".xlsx", ".xls"}:
        return []
    key = (str(path), path.stat().st_mtime)
    if key not in _sheet_cache:
        try:
            _sheet_cache[key] = pd.ExcelFile(path).sheet_names
        except Exception:  # a corrupt or unreadable workbook must not break listing
            _sheet_cache[key] = []
    return _sheet_cache[key]


def _numeric_columns(frame):
    return sum(1 for column in frame.columns if str(frame[column].dtype).startswith(("int", "float")))


def _read_csv(path, sep=None, **options):
    """Read a CSV, trying the European convention when the file looks European.

    A ';'-separated file usually writes numbers as "1.234,5"; with pandas' defaults those
    columns come back as text, and the model then spends its steps converting them by hand
    or misreads the shape entirely (docs/qa-report-2026-09-15.md V6: 7 steps, 3 errors, and
    one run that reported "3 rows, 1 column" for a 3-column file). Both parses are tried and
    the one that yields more real numbers wins — a decision made from the data, not a guess.
    """
    raw = _pandas_originals.get("read_csv", pd.read_csv)
    frame = raw(path, sep=sep, engine="python", **options) if sep is None else raw(path, sep=sep, **options)
    if _numeric_columns(frame) == len(frame.columns):
        return frame
    with open(path, encoding="utf-8", errors="replace") as handle:
        head = handle.readline()
    if head.count(";") <= head.count(","):
        return frame
    try:
        european = raw(path, sep=";", decimal=",", thousands=".", **options)
    except Exception:
        return frame
    if _numeric_columns(european) <= _numeric_columns(frame):
        return frame
    print(f"Note: {Path(path).name} was read as a European CSV (';' separator, ',' decimal).")
    return european


_pandas_originals = {}


def patch_pandas_readers():
    """Give `pd.read_csv`/`pd.read_excel` what `load_dataset()` knows, for code that skips it.

    Measured over 1,625 real python cells (2026-09-16): the model reads a file with pandas
    directly in 456 of them and through `load_dataset()` in 208 — roughly two out of three
    reads never pass the helper, so knowledge kept only in the helper reaches a minority of
    the code that needs it. This is the same move `mark_saved_figures()` already makes for
    `Figure.savefig`: put the behaviour where the model actually is.

    Nothing is blocked and no data is changed silently: an explicit `sep`/`decimal` or
    `sheet_name` is obeyed as-is, and each adjustment prints one line saying what it did.
    """
    if _pandas_originals:
        return
    _pandas_originals["read_csv"] = pd.read_csv
    _pandas_originals["read_excel"] = pd.read_excel

    def read_csv(filepath_or_buffer, *args, **options):
        told = {"sep", "delimiter", "decimal", "thousands", "engine"} & set(options)
        if args or told or not _local_file(filepath_or_buffer):
            return _pandas_originals["read_csv"](filepath_or_buffer, *args, **options)
        return _read_csv(Path(filepath_or_buffer), **options)

    def read_excel(io, *args, **options):
        frame = _pandas_originals["read_excel"](io, *args, **options)
        if not args and options.get("sheet_name") is None and _local_file(io):
            names = _sheets(Path(io))
            if len(names) > 1:
                print(
                    f"Note: {Path(io).name} has sheets {', '.join(names)} and this read only {names[0]!r}. "
                    f"Read another with sheet_name={names[1]!r}."
                )
        return frame

    pd.read_csv = read_csv
    pd.read_excel = read_excel


def _local_file(target):
    return isinstance(target, (str, os.PathLike)) and os.path.exists(target)


def load_dataset(name=None):
    """Load a dataset into a pandas DataFrame: exact path, part of a file name, one sheet ("book.xlsx#Q2"), or the newest file."""
    names = [item["name"] for item in list_datasets()]
    if not names:
        raise ValueError("no .csv/.tsv/.xlsx/.xls/.parquet file in the working directory")
    if name is None:
        match = names[0]
    else:
        wanted = str(name).strip()
        match = wanted if wanted in names else next((n for n in names if wanted.casefold() in n.casefold()), None)
        if match is None:
            raise ValueError(f"dataset {name!r} not found; the datasets here are: {', '.join(names)}")
    file_name, _, sheet = match.partition("#")
    path = _working_path(file_name)
    key = (match, path.stat().st_mtime)
    if key not in _dataset_cache:
        suffix = path.suffix.lower()
        if suffix == ".csv":
            frame = _read_csv(path)
        elif suffix == ".tsv":
            frame = _read_csv(path, sep="\t")
        elif suffix in {".xlsx", ".xls"}:
            frame = pd.read_excel(path, sheet_name=sheet or 0)
        else:
            frame = pd.read_parquet(path)
        _dataset_cache[key] = frame
    frame = _dataset_cache[key]
    sheets = _sheets(path)
    where = f" sheet {sheet or sheets[0]!r}" if sheets else ""
    others = [name for name in sheets if name != (sheet or sheets[0] if sheets else None)]
    # Saying which sheets were NOT loaded: reading only the first one silently is how a
    # workbook's other sheets went missing from an answer (docs/qa-report-2026-09-15.md V5).
    extra = f" — this workbook also has {', '.join(others)}; load one with load_dataset(\"{file_name}#{others[0]}\")" if others else ""
    print(f"Loaded {file_name}{where}: {len(frame)} rows x {len(frame.columns)} columns{extra}")
    # A copy per call: the cached frame is the file as it was read. Handing the same object
    # out twice meant a model that modified it got its own edits back from what reads like a
    # fresh load of the file — wrong data, with nothing to show for it.
    return frame.copy()


def profile_dataset(name=None, sample_rows=5, max_columns=50):
    """One-call overview: shape, dtypes, missing values, duplicates, numeric summary, head."""
    frame = load_dataset(name)
    columns = list(frame.columns)
    shown = columns[: int(max_columns)]
    sample = max(1, min(int(sample_rows), 10))
    lines = [
        f"shape={frame.shape}" + (f" (showing {len(shown)} of {len(columns)} columns)" if len(shown) < len(columns) else ""),
        f"dtypes: { {str(c): str(frame[c].dtype) for c in shown} }",
        f"missing: { {str(c): int(frame[c].isna().sum()) for c in shown} }",
        f"duplicated_rows: {int(frame.duplicated().sum())}",
    ]
    numeric = [c for c in shown if str(frame[c].dtype).startswith(("int", "float"))][:8]
    if numeric:
        lines.append("numeric summary:\n" + frame[numeric].describe().round(3).to_string())
    head = frame[shown].head(sample).to_string(index=False)
    lines.append(f"head({sample}):\n" + (head[:4000] + "\n…[head truncated]" if len(head) > 4000 else head))
    print("\n".join(lines))


def save_artifact(relative_path, content):
    """Save text, bytes, JSON-compatible data, a Matplotlib figure or a Pillow image under the output folder."""
    relative = Path(str(relative_path))
    if relative.parts and relative.parts[0] == "generated":
        relative = Path(*relative.parts[1:])
    target = _working_path(Path(_OUTPUT_DIR) / relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    suffix = target.suffix.lower()
    try:
        if isinstance(content, (bytes, bytearray, memoryview)):
            target.write_bytes(bytes(content))
        elif isinstance(content, str):
            target.write_text(content, encoding="utf-8")
        elif callable(getattr(content, "savefig", None)):
            if not suffix:
                raise ValueError("a figure needs a file extension such as .png or .pdf")
            content.savefig(target, format=suffix.lstrip("."), bbox_inches="tight")
            # Close it so runner.py does not save the same figure again.
            plt.close(content)
        elif suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"} and callable(getattr(content, "save", None)):
            content.save(target)
        elif isinstance(content, (dict, list, tuple, int, float, bool)) or content is None:
            target.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            raise TypeError("content must be text, bytes, JSON-compatible data, a Matplotlib figure or a Pillow image")
        if not target.read_bytes():
            raise ValueError(f"{target.name} is empty")
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return (Path(_OUTPUT_DIR) / relative).as_posix()


def history(turn):
    """Full record of turn `turn` (from 1) of this conversation — messages, code, outputs — read from the conversation log."""
    return _fox_host({"kind": "history", "turn": int(turn)})
