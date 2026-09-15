"""Data helpers preloaded into the `python` tool's IPython session.

Datasets are the tabular files anywhere under the working directory, except
generated/ and hidden paths. Adapted from agent-core's
bundles/loop-drivers/loop-rlm/python/rlm_agent/tools.py, without its upload
index (index.json) and per-conversation draft folders.
"""

import json
import os
from pathlib import Path

_DATASET_SUFFIXES = {".csv", ".tsv", ".xlsx", ".xls", ".parquet"}
# generated/ for a chat of its own; generated/<chat id> in a shared project folder.
_OUTPUT_DIR = os.environ.get("FOX_OUTPUT_DIR", "generated")
_dataset_cache = {}


def _working_path(relative_path):
    root = Path.cwd().resolve()
    target = (root / str(relative_path)).resolve()
    if target != root and root not in target.parents:
        raise ValueError("path escapes the working directory")
    return target


def list_datasets():
    """Tabular files in the working directory, newest first."""
    root = Path.cwd()
    items = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if not path.is_file() or path.suffix.lower() not in _DATASET_SUFFIXES:
            continue
        if relative.parts[0] == "generated" or any(part.startswith(".") for part in relative.parts):
            continue
        stat = path.stat()
        items.append({"name": relative.as_posix(), "size_bytes": stat.st_size, "modified": stat.st_mtime})
    return sorted(items, key=lambda item: item["modified"], reverse=True)


def load_dataset(name=None):
    """Load a dataset into a pandas DataFrame: exact path, part of a file name, or the newest file."""
    import pandas as pd

    names = [item["name"] for item in list_datasets()]
    if not names:
        raise ValueError("no .csv/.tsv/.xlsx/.xls/.parquet file in the working directory")
    if name is None:
        match = names[0]
    else:
        wanted = str(name).strip()
        match = wanted if wanted in names else next((n for n in names if wanted.casefold() in n.casefold()), None)
        if match is None:
            raise ValueError(f"dataset {name!r} not found; call list_datasets()")
    path = _working_path(match)
    key = (match, path.stat().st_mtime)
    if key in _dataset_cache:
        return _dataset_cache[key]
    suffix = path.suffix.lower()
    if suffix == ".csv":
        frame = pd.read_csv(path, sep=None, engine="python")
    elif suffix == ".tsv":
        frame = pd.read_csv(path, sep="\t")
    elif suffix in {".xlsx", ".xls"}:
        frame = pd.read_excel(path)
    else:
        frame = pd.read_parquet(path)
    _dataset_cache[key] = frame
    print(f"Loaded {match}: {len(frame)} rows x {len(frame.columns)} columns")
    return frame


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
            import matplotlib.pyplot as plt

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
