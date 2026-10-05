"""Persist a completed pipeline_v3 answer into the conversation history collections.

Self-contained for pipeline_v3 (v1/v2 are gone). Given a V3Result, this writes a user
message + an assistant message, and under the assistant message one query_result per executed SQL:
one for a simple answer, one PER SUB-QUESTION for a decomposed answer — each snapshotting its own
rows + chart specs, so a multi-part answer's per-sub charts survive a reload.

Returns (conversation_id, assistant_message_id, chart_ids) so the caller can hand the saved chart
ids back to the client (keyed by sub-question id, or "_" for a simple answer).
"""

from typing import Any

from src.crud_mongo import conversation as conversation_crud
from src.database.mongodb import AttrDatabase, AttrDict

_TITLE_MAX = 80


def _display_columns(rows: list[dict]) -> list[dict]:
    return [{"key": k, "label": k} for k in rows[0].keys()] if rows else []


def result_to_packaged(result: Any, question: str) -> dict[str, Any]:
    """Adapt a pipeline_v3 V3Result to the packaged-dict shape save_answer expects.

    A DECOMPOSED answer (result.sub_results present) is saved in the decomposed shape: ONE
    query_result per sub-question, each with its OWN sql/rows/charts — so a multi-part answer's
    per-sub charts survive a reload. A simple answer is the single-result shape."""
    subs = list(getattr(result, "sub_results", None) or [])
    answer_markdown = result.answer_markdown
    follow_ups = list(getattr(result, "follow_up_questions", None) or [])

    if subs:
        sub_results = [
            {
                "id": s.get("id"),
                "question": s.get("question"),
                "success": s.get("success", True),
                "sql": s.get("sql"),
                "rows": s.get("rows") or [],
                "row_count": s.get("row_count", 0) or 0,
                "charts": s.get("charts") or [],
                "display_columns": _display_columns(s.get("rows") or []),
            }
            for s in subs
        ]
        return {
            "question": question,
            "success": result.success,
            "answer_markdown": answer_markdown,   # the ONE unified combined answer
            "follow_up_questions": follow_ups,
            "decomposed": True,
            "sub_results": sub_results,
        }

    return {
        "question": question,
        "success": result.success,
        "sql": result.sql,
        "rows": result.rows,
        "row_count": result.row_count,
        "answer_markdown": answer_markdown,
        "charts": list(getattr(result, "charts", None) or []),
        "display_columns": _display_columns(result.rows),
        "follow_up_questions": follow_ups,
        "decomposed": False,
    }


def save_answer(
    db: AttrDatabase,
    packaged: dict[str, Any],
    conversation_id: str | None,
) -> tuple[str, str, dict[str, list[str]]]:
    question = packaged.get("question", "")

    conversation = _get_or_create_conversation(db, conversation_id, question)
    base_seq = conversation_crud.next_message_seq(db, conversation.id)

    # user turn
    conversation_crud.create_message(
        db, conversation_id=conversation.id, seq=base_seq, role="user",
        content=question, question=question,
    )

    # assistant turn
    assistant_msg = conversation_crud.create_message(
        db, conversation_id=conversation.id, seq=base_seq + 1, role="assistant",
        content=packaged.get("answer_markdown", "") or "",
        question=question,
        answer_markdown=packaged.get("answer_markdown"),
        is_decomposed=bool(packaged.get("decomposed")),
        follow_up_questions=packaged.get("follow_up_questions") or [],
    )

    # query_results (+ charts) — one per executed SQL. Collect the saved chart ids keyed by
    # sub-question (or "_" for a single answer) in ORIGINAL chart order, so the caller can hand
    # them back to the client and live (just-answered) charts become editable/persistable.
    chart_ids: dict[str, list[str]] = {}
    if packaged.get("decomposed"):
        for i, sub in enumerate(packaged.get("sub_results", [])):
            key = sub.get("id") or f"q{i + 1}"
            chart_ids[key] = _add_query_result(db, assistant_msg.id, i, sub,
                                               sub_id=sub.get("id"), sub_question=sub.get("question"))
    else:
        chart_ids["_"] = _add_query_result(db, assistant_msg.id, 0, packaged)

    conversation_crud.update_conversation(db, conversation.id)
    return conversation.id, assistant_msg.id, chart_ids


def _add_query_result(
    db: AttrDatabase, message_id: str, seq: int, data: dict[str, Any],
    sub_id: str | None = None, sub_question: str | None = None,
) -> list[str]:
    """Returns the saved chart ids in the SAME order as data['charts'] (the client's live order)."""
    qr = conversation_crud.create_query_result(
        db, message_id=message_id, seq=seq,
        sub_id=sub_id, sub_question=sub_question,
        sql=data.get("sql"),
        row_count=data.get("row_count", 0) or 0,
        rows=data.get("rows") or [],
        display_columns=data.get("display_columns") or [],
    )

    chart_ids: list[str] = []
    for spec in data.get("charts") or []:
        ch = conversation_crud.create_chart(
            db, query_result_id=qr.id,
            type=spec.get("type", "table"),
            title=spec.get("title", "") or "",
            description=spec.get("description", "") or "",
            x=spec.get("x"),
            y=spec.get("y") or [],
            value_field=spec.get("value_field"),
            recommended=bool(spec.get("recommended")),
            # per-chart data + its transform, so a reload renders EXACTLY what streaming showed
            rows=spec.get("rows") or [],
            transform_code=spec.get("transform_code", "") or "",
        )
        chart_ids.append(ch.id)
    return chart_ids


def _get_or_create_conversation(db: AttrDatabase, cid: str | None, question: str) -> AttrDict:
    if cid is not None:
        conv = conversation_crud.get_conversation(db, cid)
        if conv is not None:
            return conv
    return conversation_crud.create_conversation(db, title=_title_from(question))


def _title_from(question: str) -> str:
    q = question.strip().replace("\n", " ")
    return q[:_TITLE_MAX] + ("…" if len(q) > _TITLE_MAX else "")
