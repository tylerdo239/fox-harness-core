"""Restricted in-process executor for model-generated pandas code.

Both the Transform and Compose agents WRITE pandas code (the agent decides how to derive/merge),
and that code runs here in a locked-down namespace: only `pd` and the input DataFrame(s) are in
scope, `__builtins__` is stripped to a tiny safe allowlist, and `import`/file/network are absent.

This is a restricted-exec sandbox, not a security boundary against a hostile actor — the input is
our own local model operating over our own data. It stops accidents (a stray `open(...)`, an
`import os`) and keeps the generated code to the one job: transform DataFrames in, DataFrame out.

Contract: the generated code must assign its output DataFrame to a variable named `result`.
"""

from __future__ import annotations

import pandas as pd

# A tiny allowlist of builtins the pandas code may legitimately need. No open/eval/exec/import/
# __import__/getattr/compile/input, no file or network access.
_SAFE_BUILTINS = {
    "len": len, "range": range, "min": min, "max": max, "sum": sum, "abs": abs,
    "round": round, "sorted": sorted, "list": list, "dict": dict, "set": set,
    "tuple": tuple, "str": str, "int": int, "float": float, "bool": bool,
    "enumerate": enumerate, "zip": zip, "map": map, "filter": filter, "any": any, "all": all,
}

_FORBIDDEN = ("import", "__", "open(", "eval(", "exec(", "compile(", "globals(", "locals(",
              "getattr(", "setattr(", "os.", "sys.", "subprocess", "socket", "pathlib", "Path(")


def run_pandas_code(code: str, dataframes: dict[str, pd.DataFrame]) -> tuple[list[dict] | None, str | None]:
    """Execute `code` with the given DataFrames in scope. `code` must assign a DataFrame to
    `result`. Returns (rows, None) on success or (None, error). Never raises.

    dataframes maps variable name → DataFrame, e.g. {"df": ...} for Transform or
    {"dfs": [...], "df0": ..., "df1": ...} for Compose.
    """
    lowered = code.lower()
    for bad in _FORBIDDEN:
        if bad in lowered:
            return None, f"forbidden token in generated code: {bad!r}"

    namespace: dict = {"pd": pd, "__builtins__": _SAFE_BUILTINS}
    namespace.update(dataframes)

    try:
        exec(code, namespace)  # noqa: S102 — restricted namespace; see module docstring
    except Exception as e:  # noqa: BLE001
        return None, f"pandas code raised: {type(e).__name__}: {e}"

    result = namespace.get("result")
    if result is None:
        return None, "generated code did not assign a `result` DataFrame"
    if isinstance(result, pd.Series):
        result = result.to_frame()
    if not isinstance(result, pd.DataFrame):
        return None, f"`result` is {type(result).__name__}, expected a DataFrame"
    # NaN → None so the rows serialize cleanly to JSON
    return result.where(pd.notna(result), None).to_dict(orient="records"), None
