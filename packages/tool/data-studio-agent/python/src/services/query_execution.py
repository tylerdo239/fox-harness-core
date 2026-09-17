from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlmodel import Session, select

from src.database.models import Entity, EntityColumn
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


def execute_and_check(
    session: Session,
    client: DremioClient,
    sql: str,
    base_entity_id: int,
    fetch_limit: int = 500,
    timeout_sec: float = 60,
) -> ExecutionResult:
    started_at = datetime.now()

    try:
        result = client.run_sql_with_meta(sql, timeout_sec=timeout_sec, fetch_limit=fetch_limit)
    except DremioQueryError as e:
        latency_ms = int((datetime.now() - started_at).total_seconds() * 1000)
        return ExecutionResult(success=False, error=str(e), latency_ms=latency_ms)

    latency_ms = int((datetime.now() - started_at).total_seconds() * 1000)
    rows = result["rows"]
    row_count = result["row_count"]

    execution = ExecutionResult(success=True, rows=rows, row_count=row_count, latency_ms=latency_ms)
    execution.sanity_flags = _run_sanity_checks(session, rows, row_count, base_entity_id)
    return execution


def _run_sanity_checks(
    session: Session, rows: list[dict[str, Any]], row_count: int, base_entity_id: int
) -> list[SanityFlag]:
    flags: list[SanityFlag] = []

    if row_count == 0:
        flags.append(SanityFlag(SanityFlagType.EMPTY_RESULT, "Query returned no rows"))
        return flags

    base_entity = session.get(Entity, base_entity_id)
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

        flags.extend(_check_implausible_values(session, rows, column_names, base_entity_id))

    return flags


def _check_implausible_values(
    session: Session, rows: list[dict[str, Any]], column_names: list[str], base_entity_id: int
) -> list[SanityFlag]:
    """Only checks columns that unambiguously belong to the base entity. Columns pulled in via
    joins aren't checked here since raw result rows don't carry per-column table provenance."""
    flags: list[SanityFlag] = []

    for col_name in column_names:
        profile = session.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == base_entity_id,
                EntityColumn.physical_name == col_name,
            )
        ).first()
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
