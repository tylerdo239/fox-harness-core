"""Save a pipeline v4 answer into the conversation history (conversations, messages, query_results,
charts): the same collections the conversation list and GET /chat/conversations/{id} read.

Each question adds a user message and an assistant message. The assistant message gets one
query_result (the SQL, rows and columns) when a query ran, with one chart per chart shown, saved
in the shape the UI draws (ChartSpec), so the toolbar can edit it and it can be pinned to a dashboard."""

import json
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

from src.crud_mongo._shared import new_id, utcnow
from src.crud_mongo.conversation import (
    CHART_COLLECTION,
    CONVERSATION_COLLECTION,
    MESSAGE_COLLECTION,
    QUERY_RESULT_COLLECTION,
)
from src.pipeline_v4.answer import V4Answer

TITLE_MAX = 80


def title_of(question: str) -> str:
    q = " ".join(question.split())
    return q[:TITLE_MAX] + ("…" if len(q) > TITLE_MAX else "")


async def _conversation(db: AsyncDatabase, conversation_id: str | None, question: str) -> str:
    if conversation_id and await db[CONVERSATION_COLLECTION].find_one(
            {"_id": conversation_id, "deleted_at": None}, {"_id": 1}):
        return conversation_id
    now = utcnow()
    doc = {"_id": new_id(), "title": title_of(question), "created_at": now, "updated_at": now, "deleted_at": None}
    await db[CONVERSATION_COLLECTION].insert_one(doc)
    return doc["_id"]


async def _next_seq(db: AsyncDatabase, conversation_id: str) -> int:
    last = await db[MESSAGE_COLLECTION].find_one({"conversation_id": conversation_id}, {"seq": 1}, sort=[("seq", -1)])
    return 0 if last is None else last["seq"] + 1


def _message(conversation_id: str, seq: int, role: str, content: str, question: str, **extra: Any) -> dict[str, Any]:
    return {"_id": new_id(), "conversation_id": conversation_id, "seq": seq, "role": role, "content": content,
            "question": question, "answer_markdown": None, "is_decomposed": False, "follow_up_questions_json": [],
            "created_at": utcnow(), **extra}


def chart_spec(chart: dict[str, Any]) -> dict[str, Any]:
    """A v4 chart as the UI's ChartSpec fields (type, title, x, y, value_field, rows)."""
    kind = chart["type"]
    if kind == "stat":
        field = chart.get("title", "") + (f" ({chart['unit']})" if chart.get("unit") else "")
        return {"type": "stat", "title": chart.get("title") or "", "x": None, "y": [], "value_field": field,
                "rows": [{field: chart.get("value")}]}
    if kind == "table":
        return {"type": "table", "title": chart.get("title") or "", "x": None, "y": chart.get("columns") or [],
                "value_field": None, "rows": chart.get("rows") or []}
    return {"type": kind, "title": chart.get("title") or "", "x": chart.get("x"), "y": chart.get("y") or [],
            "value_field": None, "rows": chart.get("rows") or []}


def _chart(query_result_id: str, chart: dict[str, Any]) -> dict[str, Any]:
    now = utcnow()
    spec = chart_spec(chart)
    return {"_id": new_id(), "query_result_id": query_result_id, "type": spec["type"],
            "title": spec["title"], "description": "", "x": spec["x"], "y_json": spec["y"],
            "value_field": spec["value_field"], "recommended": bool(chart.get("recommended")), "rows_json": spec["rows"],
            "transform_code": "", "title_override": None, "x_override": None, "y_override_json": None,
            "color_overrides_json": {}, "label_overrides_json": dict(chart.get("labels") or {}), "is_pinned": False,
            "created_at": now, "updated_at": now}


DELTAS = ("agent_delta", "answer_delta")
MAX_EVENTS_CHARS = 8_000_000   # a Mongo document holds 16 MB; past this the agents' streamed text is left out


Event = tuple[str, dict[str, Any]] | tuple[str, dict[str, Any], int]   # (kind, data[, epoch ms])


def compact_events(events: list[Event]) -> list[dict[str, Any]]:
    """The run's events as saved for replay ({type, data, t}): the streamed text pieces of one agent run
    are joined (only between that run's other events, so replaying gives the same state)."""
    out: list[dict[str, Any]] = []
    open_delta: dict[tuple[str, str], int] = {}   # (kind, run_id) → index of the delta still growing
    for kind, data, *rest in events:
        t = rest[0] if rest else None
        rid = str(data.get("run_id", ""))
        if kind in DELTAS:
            at = open_delta.get((kind, rid))
            if at is not None:
                out[at]["data"]["delta"] += data.get("delta", "")
                continue
            open_delta[(kind, rid)] = len(out)
            out.append({"type": kind, "data": dict(data), "t": t})
            continue
        if kind == "answer_reset":
            open_delta = {k: v for k, v in open_delta.items() if k[0] != "answer_delta"}
        elif rid:
            open_delta = {k: v for k, v in open_delta.items() if k[1] != rid}
        out.append({"type": kind, "data": data, "t": t})
    if len(json.dumps(out, ensure_ascii=False, default=str)) > MAX_EVENTS_CHARS:
        out = [e for e in out if e["type"] not in DELTAS]
    return out


async def save_answer(db: AsyncDatabase, answer: V4Answer, conversation_id: str | None,
                      events: list[Event] | None = None) -> tuple[str, str, list[str | None]]:
    """Returns (conversation_id, assistant message id, the saved chart id of each shown chart, in order).

    One query_result per sub-question that ran (with its spec, for the conversation history); a
    question answered in several parts is saved decomposed (sub_id / sub_question set)."""
    shown = answer.presentation
    several = len(answer.parts) > 1
    cid = await _conversation(db, conversation_id, answer.question)
    seq = await _next_seq(db, cid)
    await db[MESSAGE_COLLECTION].insert_one(_message(cid, seq, "user", answer.question, answer.question))
    assistant = _message(cid, seq + 1, "assistant", shown.answer_markdown, answer.question,
                         answer_markdown=shown.answer_markdown, is_decomposed=several,
                         follow_up_questions_json=[f["question"] for f in shown.follow_ups if f.get("question")],
                         status=shown.status, standalone_question=answer.standalone or answer.question,
                         parts_json=[{"id": p.id, "question": p.question} for p in answer.parts],
                         timings_json=answer.timings)
    await db[MESSAGE_COLLECTION].insert_one(assistant)

    chart_ids: list[str | None] = [None] * len(shown.charts)
    for i, part in enumerate(answer.parts):
        result = part.result
        if part.sql is None or result is None or result.status == "failed":
            continue
        qr = {"_id": new_id(), "message_id": assistant["_id"], "seq": i,
              "sub_id": part.id if several else None, "sub_question": part.question if several else None,
              "sql": part.sql, "spec_json": part.spec, "row_count": result.row_count, "rows_json": result.rows,
              "display_columns_json": [{"key": c.name, "label": c.name} for c in result.columns],
              "created_at": utcnow()}
        await db[QUERY_RESULT_COLLECTION].insert_one(qr)
        mine = [k for k, c in enumerate(shown.charts) if c.get("part", answer.parts[0].id) == part.id]
        charts = [_chart(qr["_id"], shown.charts[k]) for k in mine]
        if charts:
            await db[CHART_COLLECTION].insert_many(charts)
            for k, c in zip(mine, charts, strict=True):
                chart_ids[k] = c["_id"]

    # what reopening the answer replays (events) and the saved id of each chart in their order
    await db[MESSAGE_COLLECTION].update_one({"_id": assistant["_id"]}, {"$set": {
        "events_json": compact_events(events or []), "chart_ids_json": chart_ids}})
    await db[CONVERSATION_COLLECTION].update_one({"_id": cid}, {"$set": {"updated_at": utcnow()}})
    return cid, assistant["_id"], chart_ids
