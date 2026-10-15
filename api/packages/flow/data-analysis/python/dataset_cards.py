"""Dataset cards: a deterministic schema summary of a project's uploaded tables.

Run by the gateway after an upload or a delete (services/gateway/src/runtime/dataset-cards.ts), inside
the same sandbox as the python tool, with the workspace mounted read-only. Ported from
local-fox-harness-core (its docs/data-analyst-agent-review.md I2).

stdin:  JSON array of tabular paths relative to the working directory.
stdout: JSON array of {"name", "rows", "sampled", "columns": [{"name", "dtype", "nulls"}]} or {"name", "error"}.

Reads at most SAMPLE_ROWS rows of a CSV/TSV/Excel file for the dtypes and nulls; a file whose row count
reaches the cap is reported with "sampled": true, so nobody reads a partial count as the real one.
Parquet keeps its exact row count in its metadata and is read one batch at a time, never whole.
"""

import json
import sys
from pathlib import Path

import pandas as pd

SAMPLE_ROWS = 20_000
MAX_BYTES = 200 * 1024 * 1024
MAX_COLUMNS = 25


def read(path):
    """(frame of at most SAMPLE_ROWS rows, exact row count or None)."""
    suffix = path.suffix.lower()
    if suffix in {".csv", ".tsv"}:
        sep = "\t" if suffix == ".tsv" else ","
        try:
            return pd.read_csv(path, sep=sep, nrows=SAMPLE_ROWS), None
        except UnicodeDecodeError:  # a Windows-saved CSV; the python tool's pd.read_csv falls back the same way
            return pd.read_csv(path, sep=sep, nrows=SAMPLE_ROWS, encoding="cp1258", encoding_errors="replace"), None
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path, sheet_name=0, nrows=SAMPLE_ROWS), None
    import pyarrow.parquet as pq

    parquet = pq.ParquetFile(path)
    batch = next(parquet.iter_batches(batch_size=SAMPLE_ROWS), None)
    frame = batch.to_pandas() if batch is not None else parquet.schema_arrow.empty_table().to_pandas()
    return frame, parquet.metadata.num_rows


def card(name):
    path = Path(name)
    try:
        if not path.is_file():
            return {"name": name, "error": "not a file"}
        if path.stat().st_size > MAX_BYTES:
            return {"name": name, "error": "file too large to profile"}
        frame, total = read(path)
        columns = [
            {"name": str(column), "dtype": str(frame[column].dtype), "nulls": int(frame[column].isna().sum())}
            for column in list(frame.columns)[:MAX_COLUMNS]
        ]
        return {
            "name": name,
            "rows": int(total if total is not None else len(frame)),
            "sampled": total is None and len(frame) >= SAMPLE_ROWS,
            "columns": columns,
            "columnCount": int(frame.shape[1]),
        }
    except Exception as error:  # one unreadable file must not lose the others
        return {"name": name, "error": f"{type(error).__name__}: {error}"[:300]}


def main():
    names = json.loads(sys.stdin.read() or "[]")
    print(json.dumps([card(name) for name in names], ensure_ascii=False))


if __name__ == "__main__":
    main()
