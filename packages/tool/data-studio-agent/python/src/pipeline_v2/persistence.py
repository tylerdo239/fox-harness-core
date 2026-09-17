"""Persist a completed v2 answer into the conversation history tables.

Given the packaged answer dict (single or decomposed), this writes a user message + an assistant
message, and under the assistant message one query_result per executed SQL (one for a simple
answer, one per sub-question for a decomposed answer), each snapshotting its rows + its chart
specs. Auto-creates a conversation when none is passed; otherwise appends to the given one.

Returns (conversation_id, assistant_message_id) so the caller can hand them back to the client.
"""

from typing import Any

from sqlmodel import Session, func, select

from src.database.models import Chart, Conversation, Message, QueryResult
from src.database.models.enums import MessageRole

_TITLE_MAX = 80


def v3_to_packaged(result: Any, question: str) -> dict[str, Any]:
    """Adapt a pipeline_v3 V3Result to the packaged-dict shape save_answer expects. v3 answers are
    single-result (decompose+compose already merged into one rows/answer), so this is always the
    non-decomposed shape: one query_result, the chart (if any) as a single-element charts list."""
    charts = list(getattr(result, "charts", None) or [])
    display_columns = []
    if result.rows:
        display_columns = [{"key": k, "label": k} for k in result.rows[0].keys()]
    return {
        "question": question,
        "success": result.success,
        "sql": result.sql,
        "rows": result.rows,
        "row_count": result.row_count,
        "answer_markdown": result.answer_markdown,
        "charts": charts,
        "display_columns": display_columns,
        "follow_up_questions": list(getattr(result, "follow_up_questions", None) or []),
        "decomposed": False,
    }


def save_answer(
    session: Session,
    packaged: dict[str, Any],
    conversation_id: int | None,
) -> tuple[int, int, dict[str, list[int]]]:
    question = packaged.get("question", "")

    conversation = _get_or_create_conversation(session, conversation_id, question)
    base_seq = _next_message_seq(session, conversation.id)

    # user turn
    user_msg = Message(
        conversation_id=conversation.id, seq=base_seq, role=MessageRole.USER,
        content=question, question=question,
    )
    session.add(user_msg)

    # assistant turn
    assistant_msg = Message(
        conversation_id=conversation.id, seq=base_seq + 1, role=MessageRole.ASSISTANT,
        content=packaged.get("answer_markdown", "") or "",
        question=question,
        answer_markdown=packaged.get("answer_markdown"),
        is_decomposed=bool(packaged.get("decomposed")),
        follow_up_questions_json=packaged.get("follow_up_questions") or [],
    )
    session.add(assistant_msg)
    session.flush()  # assign assistant_msg.id

    # query_results (+ charts) — one per executed SQL. Collect the saved chart ids keyed by
    # sub-question (or "_" for a single answer) in ORIGINAL chart order, so the caller can hand
    # them back to the client and live (just-answered) charts become editable/persistable.
    chart_ids: dict[str, list[int]] = {}
    if packaged.get("decomposed"):
        for i, sub in enumerate(packaged.get("sub_results", [])):
            key = sub.get("id") or f"q{i + 1}"
            chart_ids[key] = _add_query_result(session, assistant_msg.id, i, sub,
                                               sub_id=sub.get("id"), sub_question=sub.get("question"))
    else:
        chart_ids["_"] = _add_query_result(session, assistant_msg.id, 0, packaged)

    conversation.updated_at = _now()
    session.add(conversation)
    session.commit()
    return conversation.id, assistant_msg.id, chart_ids


def _add_query_result(
    session: Session, message_id: int, seq: int, data: dict[str, Any],
    sub_id: str | None = None, sub_question: str | None = None,
) -> list[int]:
    """Returns the saved chart ids in the SAME order as data['charts'] (the client's live order)."""
    # only persist a result if the sub-question actually produced one
    if not data.get("success", True) and not data.get("rows"):
        # still record it (empty) so the decomposed structure is complete, but skip charts
        pass
    qr = QueryResult(
        message_id=message_id, seq=seq,
        sub_id=sub_id, sub_question=sub_question,
        sql=data.get("sql"),
        row_count=data.get("row_count", 0) or 0,
        rows_json=data.get("rows") or [],
        display_columns_json=data.get("display_columns") or [],
    )
    session.add(qr)
    session.flush()  # qr.id

    charts: list[Chart] = []
    for spec in data.get("charts") or []:
        ch = Chart(
            query_result_id=qr.id,
            type=spec.get("type", "table"),
            title=spec.get("title", "") or "",
            description=spec.get("description", "") or "",
            x=spec.get("x"),
            y_json=spec.get("y") or [],
            value_field=spec.get("value_field"),
            recommended=bool(spec.get("recommended")),
            # per-chart data + its transform, so a reload renders EXACTLY what streaming showed
            rows_json=spec.get("rows") or [],
            transform_code=spec.get("transform_code", "") or "",
        )
        session.add(ch)
        charts.append(ch)
    session.flush()  # assign chart ids
    return [c.id for c in charts]


def _get_or_create_conversation(session: Session, cid: int | None, question: str) -> Conversation:
    if cid is not None:
        conv = session.get(Conversation, cid)
        if conv is not None:
            return conv
    conv = Conversation(title=_title_from(question), created_at=_now(), updated_at=_now())
    session.add(conv)
    session.flush()  # conv.id
    return conv


def _next_message_seq(session: Session, conversation_id: int) -> int:
    max_seq = session.exec(
        select(func.max(Message.seq)).where(Message.conversation_id == conversation_id)
    ).one()
    return 0 if max_seq is None else max_seq + 1


def _title_from(question: str) -> str:
    q = question.strip().replace("\n", " ")
    return q[:_TITLE_MAX] + ("…" if len(q) > _TITLE_MAX else "")


def _now():
    from datetime import UTC, datetime
    return datetime.now(UTC)
