"""The conversation so far, for the decomposer: earlier questions, what each was taken to mean, and
what each query used (kind of result, metrics, splits, filters, period). Raw rows are never shown."""

from dataclasses import dataclass, field
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

from src.crud_mongo.conversation import MESSAGE_COLLECTION, QUERY_RESULT_COLLECTION
from src.pipeline_v4.context import Names

MAX_TURNS = 5


@dataclass
class Turn:
    question: str
    standalone: str | None = None
    status: str | None = None
    answer: str = ""                                            # first line of the answer
    parts: list[tuple[str, str]] = field(default_factory=list)  # (sub-question, what its query used)


def _name(h: Names, real_id: str | None) -> str:
    name = h.of(real_id) if real_id else "?"
    return real_id or "?" if name == "?" else name


def spec_summary(spec: dict[str, Any] | None, h: Names) -> str:
    """One line from a saved QuerySpec (ids → names)."""
    if not spec:
        return ""
    bits = []
    if spec.get("shape") == "detail":
        bits.append(f"list of {_name(h, spec.get('entity_id'))} rows")
    metrics = [m.get("name") for m in spec.get("metrics") or []]
    if metrics:
        bits.append("measures " + ", ".join(m for m in metrics if m))
    dims = [_name(h, d.get("column_id")) + (f" by {d['time_grain']}" if d.get("time_grain") else "")
            for d in spec.get("dimensions") or []]
    if dims:
        bits.append("split by " + ", ".join(dims))
    if (rank := spec.get("rank")):
        bits.append(f"top {rank.get('top')} by {rank.get('by')}")
    filters = [f"{_name(h, f.get('column_id'))} {f.get('op')} {', '.join(map(str, f.get('values') or []))}".strip()
               for f in spec.get("filters") or []]
    filters += [f"segment {_name(h, s)}" for s in spec.get("segments") or []]
    if filters:
        bits.append("where " + "; ".join(filters))
    periods = [p.get("label") or f"{p.get('start')} … {p.get('end')}" for p in (spec.get("periods") or {}).values()]
    if periods:
        bits.append("period " + ", ".join(periods))
    return "; ".join(bits)


async def load_history(db: AsyncDatabase, conversation_id: str | None, h: Names, limit: int = MAX_TURNS) -> list[Turn]:
    if not conversation_id:
        return []
    msgs = await db[MESSAGE_COLLECTION].find(
        {"conversation_id": conversation_id, "role": "assistant", "deleted_at": None}).sort("seq", -1).to_list(limit)
    turns = []
    for m in reversed(msgs):
        qrs = await db[QUERY_RESULT_COLLECTION].find({"message_id": m["_id"]}).sort("seq", 1).to_list(None)
        parts = [(qr.get("sub_question") or m.get("question") or "", spec_summary(qr.get("spec_json"), h)) for qr in qrs]
        if not parts and m.get("spec_json"):   # answers saved before parts were saved per query_result
            parts = [(m.get("question") or "", spec_summary(m.get("spec_json"), h))]
        answer = (m.get("answer_markdown") or "").strip()
        turns.append(Turn(question=m.get("question") or "", standalone=m.get("standalone_question"),
                          status=m.get("status"), answer=answer.splitlines()[0] if answer else "", parts=parts))
    return turns


def render_history(turns: list[Turn]) -> str:
    lines = []
    for i, t in enumerate(turns, 1):
        lines.append(f"{i}. User asked: {t.question}")
        if t.standalone and t.standalone != t.question:
            lines.append(f"   taken as: {t.standalone}")
        for q, used in t.parts:
            if used:
                lines.append(f"   query{f' for {q!r}' if len(t.parts) > 1 else ''}: {used}")
        if t.answer:
            lines.append(f"   answer began: {t.answer}")
    return "\n".join(lines)
