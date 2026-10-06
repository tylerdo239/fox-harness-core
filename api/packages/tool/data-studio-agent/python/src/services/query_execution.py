import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any

from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity as _entity_crud
from src.security import role as role_mod
from src.crud_mongo import entity_column as entity_column_crud
from src.database.mongodb import AttrDatabase
from src.services.dremio_client import DremioClient, DremioQueryError

FANOUT_RATIO_THRESHOLD = 3.0
NULL_RATIO_FLAG_THRESHOLD = 0.95


class SanityFlagType(StrEnum):
    EMPTY_RESULT = "empty_result"
    LIKELY_FANOUT = "likely_fanout"
    ALL_NULL_COLUMN = "all_null_column"
    IMPLAUSIBLE_VALUE = "implausible_value"


@dataclass
class SanityFlag:
    flag_type: SanityFlagType
    message: str
    column: str | None = None


@dataclass
class ExecutionResult:
    success: bool
    rows: list[dict[str, Any]] = field(default_factory=list)
    row_count: int = 0
    latency_ms: int = 0
    error: str | None = None
    sanity_flags: list[SanityFlag] = field(default_factory=list)


def _forbidden_table_in(db: AttrDatabase, sql: str) -> str | None:
    """The physical path of a table the current role may not query, if the SQL text names one."""
    if role_mod.unrestricted():
        return None
    with role_mod.as_role(role_mod.ADMIN):
        entities = _entity_crud.list_active(db)
    lowered = sql.lower()
    for e in entities:
        if role_mod.doc_allowed(e):
            continue
        parts = e.physical_path.split(".")
        variants = {e.physical_path.lower(), ".".join(f'"{p}"' for p in parts).lower()}
        # whole identifier only: `x.y.workflow` must not match inside `x.y.workflows`
        if any(re.search(r'(?<![\w."])' + re.escape(v) + r'(?![\w"])', lowered) for v in variants):
            return e.physical_path
    return None


def execute_and_check(
    db: AttrDatabase,
    client: DremioClient,
    sql: str,
    base_entity_id: str | None,
    fetch_limit: int = 500,
    timeout_sec: float = 60,
) -> ExecutionResult:
    started_at = datetime.now()

    # Last line before Dremio (sql_validator.py already decided; this is the belt to its braces): for a
    # non-admin role, no table the role may not query may appear in the final SQL text at all.
    forbidden = _forbidden_table_in(db, sql)
    if forbidden:
        return ExecutionResult(success=False, error=f"access denied: table '{forbidden}' is not available to role '{role_mod.current()}'", latency_ms=0)

    try:
        result = client.run_sql_with_meta(sql, timeout_sec=timeout_sec, fetch_limit=fetch_limit)
    except DremioQueryError as e:
        latency_ms = int((datetime.now() - started_at).total_seconds() * 1000)
        return ExecutionResult(success=False, error=str(e), latency_ms=latency_ms)

    latency_ms = int((datetime.now() - started_at).total_seconds() * 1000)
    rows = result["rows"]
    row_count = result["row_count"]

    execution = ExecutionResult(success=True, rows=rows, row_count=row_count, latency_ms=latency_ms)
    execution.sanity_flags = _run_sanity_checks(db, rows, row_count, base_entity_id)
    return execution


def _run_sanity_checks(
    db: AttrDatabase, rows: list[dict[str, Any]], row_count: int, base_entity_id: str | None
) -> list[SanityFlag]:
    flags: list[SanityFlag] = []

    if row_count == 0:
        flags.append(SanityFlag(SanityFlagType.EMPTY_RESULT, "Query returned no rows"))
        return flags

    base_entity = entity_crud.get_by_id(db, base_entity_id)
    if base_entity is not None and base_entity.row_count_est:
        ratio = row_count / base_entity.row_count_est
        if ratio > FANOUT_RATIO_THRESHOLD:
            flags.append(
                SanityFlag(
                    SanityFlagType.LIKELY_FANOUT,
                    f"Result has {row_count} rows, {ratio:.1f}x the base entity's "
                    f"~{base_entity.row_count_est} rows ({base_entity.grain_description or 'grain unknown'}). "
                    f"A join may be duplicating rows.",
                )
            )

    if rows:
        column_names = list(rows[0].keys())
        for col_name in column_names:
            values = [r.get(col_name) for r in rows]
            if values and all(v is None for v in values):
                flags.append(
                    SanityFlag(
                        SanityFlagType.ALL_NULL_COLUMN,
                        f"Column '{col_name}' is null in every returned row",
                        column=col_name,
                    )
                )

        flags.extend(_check_implausible_values(db, rows, column_names, base_entity_id))

    return flags


def _check_implausible_values(
    db: AttrDatabase, rows: list[dict[str, Any]], column_names: list[str], base_entity_id: str | None
) -> list[SanityFlag]:
    """Only checks columns that unambiguously belong to the base entity. Columns pulled in via
    joins aren't checked here since raw result rows don't carry per-column table provenance."""
    flags: list[SanityFlag] = []

    for col_name in column_names:
        profile = entity_column_crud.get_by_entity_and_name(db, base_entity_id, col_name)
        if profile is None or profile.min_val is None or profile.max_val is None:
            continue

        min_bound = _try_float(profile.min_val)
        max_bound = _try_float(profile.max_val)
        if min_bound is None or max_bound is None:
            continue

        out_of_range = 0
        for row in rows:
            value = _try_float(row.get(col_name))
            if value is not None and not (min_bound <= value <= max_bound):
                out_of_range += 1

        if out_of_range > 0:
            flags.append(
                SanityFlag(
                    SanityFlagType.IMPLAUSIBLE_VALUE,
                    f"Column '{col_name}' has {out_of_range} value(s) outside the profiled "
                    f"range [{profile.min_val}, {profile.max_val}]",
                    column=col_name,
                )
            )

    return flags


def _try_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
