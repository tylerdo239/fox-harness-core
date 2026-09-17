from typing import Any

from sqlmodel import Session, select

from src.database.models import EntityColumn, QueryLog
from src.database.models.enums import QueryLogStatus
from src.services.pipeline_types import SubQuestionResult


def build_display_columns(session: Session, output_column_ids: list[int]) -> list[dict[str, Any]]:
    """display_name + unit-relevant metadata so the main chat agent can format/chart
    the result without knowing anything about physical schema."""
    if not output_column_ids:
        return []

    columns = session.exec(select(EntityColumn).where(EntityColumn.id.in_(output_column_ids))).all()
    columns_by_id = {c.id: c for c in columns}

    result = []
    for cid in output_column_ids:
        col = columns_by_id.get(cid)
        if col is None:
            continue
        result.append(
            {
                "column_id": col.id,
                "physical_name": col.physical_name,
                "display_name": col.display_name,
                "semantic_type": col.semantic_type.value if col.semantic_type else None,
                "role": col.role.value if col.role else None,
            }
        )
    return result


def log_query(
    session: Session,
    question: str,
    plan_json: dict[str, Any] | None,
    generated_sql: str | None,
    result: SubQuestionResult,
    latency_ms: int,
) -> QueryLog:
    if not result.success:
        status = QueryLogStatus.ERROR
    elif result.row_count == 0:
        status = QueryLogStatus.EMPTY
    else:
        status = QueryLogStatus.OK

    error_text = None
    if result.failures:
        last = result.failures[-1]
        error_text = f"[{last.step.value}/{last.error_type}] {last.message}"

    log_entry = QueryLog(
        question=question,
        plan_json=plan_json,
        generated_sql=generated_sql,
        status=status,
        error_text=error_text,
        row_count=result.row_count,
        latency_ms=latency_ms,
    )
    session.add(log_entry)
    session.commit()
    session.refresh(log_entry)
    return log_entry


def package_result(
    session: Session,
    question: str,
    result: SubQuestionResult,
) -> dict[str, Any]:
    """Final structured payload for the main chat agent: SQL, assumptions, and enough
    display metadata to format/chart correctly without touching physical schema."""
    if not result.success:
        return {
            "question": question,
            "success": False,
            "clarifying_question": result.clarifying_question,
            "assumptions": result.assumptions,
        }

    return {
        "question": question,
        "success": True,
        "sql": result.sql,
        "rows": result.rows,
        "row_count": result.row_count,
        "display_columns": result.display_columns,
        "assumptions": result.assumptions,
        "sanity_warnings": result.sanity_warnings,
    }
