"""JSON-lines bridge for the `analyze_data` tool (packages/tool/data-studio-agent).

Same protocol shape as packages/tool/python-repl/python/runner.py: one process per
worker container, started lazily on the first tool call and reused across turns.
Wraps `run_pipeline_v3` (src/pipeline_v3/orchestrator.py) directly — it is a plain
async function, only ever wrapped in FastAPI/SSE for the reference app's own web UI.
No HTTP, no auth here: this process only ever talks to its own parent (the Node
worker) over a private stdio pipe, never the network.

`run_pipeline_v3` is stateless per question (no conversation_id/history) — fox's own
session log is what carries multi-turn context; each call here is independent.

stdin:  one {"question": str, "role": "admin"|"user", "user_id": int|null, "session_id": str|null} per line
stdout: one JSON reply per line:
  {"ok": true, "answer": str, "sql": str|None, "columns": [str], "rows": [...],
   "row_count": int, "trace_md": str, "charts": [{type,x,y,title,recommended,rows,chart_id}],
   "chart": {...}|None, "chart_id": str|None, "follow_up_questions": [str], "assumptions": [str],
   "truncated": bool}
  or {"ok": false, "error": str}
  Before the reply, any number of {"progress": {...}} lines: the steps shown live in the UI (_Progress).

`chart_id` (docs/data-studio-admin-ui-plan.md phase 5 — Dashboards): the ONE
piece of state this otherwise-stateless bridge persists. `charts_chat` (see
`src/database/models/conversation.py`) requires a real
Conversation->Message->QueryResult->Chart chain (a real FK, not optional) —
pinning a chart to a dashboard later needs a real row to reference, so a
minimal (1 message) chain is created here purely to hold it. This does NOT
resurrect general conversation history/persistence — nothing here is ever
read back for context on a later call (`handle()` above is still fully
stateless per question).

Known limitation: `run_pipeline_v3`'s per-chart vision review (orchestrator.py's
`_vision_review_chart`) normally waits for the frontend to render the chart and POST
back a screenshot; with no HTTP client attached it just times out (12s/chart, up to
3 charts) and falls back to the un-reviewed chart — bounded, not a hang, but adds
latency. Acceptable for now; a headless render step could remove it later.
"""

import asyncio
import json
import os
import sys
import traceback
from pathlib import Path

# Python puts the SCRIPT's own directory (bridge/) on sys.path, not the CWD —
# so `src.*` (this service's package root, one level up) needs adding by hand.
# Kept independent of CWD since the TS kernel (packages/tool/data-studio-agent)
# invokes this by absolute path, same as packages/tool/python-repl's runner.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Agno (the LLM-call framework) posts a telemetry event to https://os-api.agno.com after EVERY agent run — awaited
# inline, ~0.8 s each, ~17 per question — unless this is "false". Forced here, before anything imports agno, so no
# deployment env can turn it back on. Agno reads it on each agent/team/workflow run.
os.environ["AGNO_TELEMETRY"] = "false"

from src.crud_mongo import conversation as conversation_crud
from src.database.models.enums import MessageRole
from src.database.mongodb import AttrDatabase, check_mongo_connection, ensure_indexes, get_async_mongo_db, get_mongo_db
from src.pipeline_v3.orchestrator import run_pipeline_v3
from src.pipeline_v4.answer import ask_v4
from src.pipeline_v4.persist import chart_spec, save_answer
from src.security import role as role_mod
from src.services.dremio_client import DremioClient
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.meili_store import MeiliStore
from src.settings import get_settings

# Cap what's handed back to the model/UI; a full result can be thousands of rows.
MAX_ROWS = 200

# Which pipeline answers (docs/data-studio-update-plan.md GĐ4): v3, the default, or v4 (the reference's newer
# one, which reads the data profile). Anything else is v3.
PIPELINE = "v4" if os.environ.get("DATA_STUDIO_PIPELINE", "").strip().lower() == "v4" else "v3"


def _owner_fields(owner: dict) -> dict:
    """{owner_id, session_id} of the asker, as known (docs/data-studio-user-dashboards-plan.md)."""
    fields = {}
    if isinstance(owner.get("user_id"), int):
        fields["owner_id"] = owner["user_id"]
    if isinstance(owner.get("session_id"), str):
        fields["session_id"] = owner["session_id"]
    return fields


def _stamp_owner(db, conversation_id: str | None, chart_ids: list, owner: dict) -> None:
    """A chart belongs to whoever asked: only that user's dashboards can show it (gateway data-studio-db.ts)."""
    fields = _owner_fields(owner)
    if not fields:
        return
    if conversation_id:
        db["conversations"].update_one({"_id": conversation_id}, {"$set": fields})
    ids = [i for i in chart_ids if i]
    if ids:
        db["charts"].update_many({"_id": {"$in": ids}}, {"$set": fields})


def _persist_charts(db: AttrDatabase, question: str, result, charts: list[dict], owner: dict | None = None) -> list[str]:
    """Minimal conversation -> message -> query_result -> chart chain so every chart (already computed
    by `handle()` below) has a real document a dashboard widget can reference. ONE chain holds all the
    charts of an answer; returns the new chart ids in the same order as `charts` (uuid strings).
    Sequential inserts, no transaction (docs/data-studio-mongodb-plan.md) — a failure midway leaves a
    partial chain, same as bot-data-studio-api."""
    if not charts:
        return []
    conversation = conversation_crud.create_conversation(db, title=question[:120])
    message = conversation_crud.create_message(
        db,
        conversation_id=conversation.id,
        seq=0,
        role=MessageRole.ASSISTANT,
        content=result.answer_markdown,
        question=question,
        answer_markdown=result.answer_markdown,
    )
    query_result = conversation_crud.create_query_result(
        db,
        message_id=message.id,
        seq=0,
        sql=result.sql,
        row_count=result.row_count,
        rows=result.rows[:MAX_ROWS],
    )
    ids = [
        conversation_crud.create_chart(
            db,
            query_result_id=query_result.id,
            type=chart.get("type", "bar"),
            title=chart.get("title") or "",
            description=chart.get("description") or "",
            x=chart.get("x"),
            y=chart.get("y") or [],
            recommended=bool(chart.get("recommended")),
            rows=(chart.get("rows") or [])[:MAX_ROWS],
            transform_code=chart.get("transform_code") or "",
        ).id
        for chart in charts
    ]
    _stamp_owner(db, conversation.id, ids, owner or {})
    return ids


def _persist_chart(db: AttrDatabase, question: str, result, chart: dict | None) -> str | None:
    """Single-chart convenience wrapper over `_persist_charts` (returns the chart's id, or None)."""
    ids = _persist_charts(db, question, result, [chart] if chart is not None else [])
    return ids[0] if ids else None


def _answer_charts(result) -> list[dict]:
    """Every chart of the answer, INCLUDING the raw-data `table` chart (last), so a table can be pinned to a
    dashboard and relabeled like any other chart (the reference UI does the same). A decomposed
    (multi-part) answer keeps its charts on each sub-result, not on the combined result."""
    charts = list(result.charts or [])
    if not charts:
        for sub in result.sub_results or []:
            charts.extend(sub.get("charts") or [])
    # visual charts first (recommended first as the pipeline ordered them), tables last
    return [c for c in charts if c.get("type") != "table"] + [c for c in charts if c.get("type") == "table"]


async def handle(question: str, llm: LLMClient, emb: EmbeddingClient, vs: MeiliStore, dremio: DremioClient,
                 owner: dict | None = None) -> dict:
    # Milestone progress (which agent/step/tool is running right now) AND every retry/
    # warning/error (orchestrator.py's `_trace()`, 2026-09-18 — "log hết"), one JSON line
    # per event on stderr — kernel.ts forwards each line straight to the worker
    # container's own stdout/stderr, so `docker logs -f` shows live pipeline
    # progress instead of nothing until the final reply. `agent_delta` is excluded:
    # it's a token-by-token content stream (SSE UI use case), far too noisy for a log.
    async def on_event(event_type: str, payload: dict) -> None:
        _PROGRESS.emit(event_type, payload)
        if event_type == "agent_delta":
            return
        print(
            json.dumps({"event": event_type, **payload}, ensure_ascii=False, default=str),
            file=sys.stderr,
            flush=True,
        )

    db = get_mongo_db()
    result = await run_pipeline_v3(db, llm, emb, vs, dremio, question, on_event=on_event)

    if result.needs_clarification:
        return {"ok": False, "error": f"Cần làm rõ câu hỏi: {result.clarifying_question}"}
    if not result.success:
        return {"ok": False, "error": result.error or "pipeline thất bại không rõ lý do"}

    answer_charts = _answer_charts(result)
    chart_ids = _persist_charts(db, question, result, answer_charts, owner)
    charts = [
        {
            "type": c.get("type", "bar"),
            "x": c.get("x"),
            "y": c.get("y") or [],
            "title": c.get("title") or "",
            "description": c.get("description") or "",
            "recommended": bool(c.get("recommended")),
            "rows": (c.get("rows") or [])[:MAX_ROWS],
            "chart_id": chart_id,
        }
        for c, chart_id in zip(answer_charts, chart_ids)
    ]

    return {
        "ok": True,
        "answer": result.answer_markdown,
        "sql": result.sql,
        "columns": list(result.rows[0].keys()) if result.rows else [],
        "rows": result.rows[:MAX_ROWS],
        "row_count": result.row_count,
        "trace_md": result.trace_md,
        # every visual chart, recommended first as the pipeline ordered them; `chart`/`chart_id` stay
        # as the first one for callers that only know the single-chart shape.
        "charts": charts,
        "chart": next((c for c in charts if c["type"] != "table"), None),
        "chart_id": next((c["chart_id"] for c in charts if c["type"] != "table"), None),
        "follow_up_questions": list(result.follow_up_questions or []),
        "assumptions": list(result.assumptions or []),
        "truncated": len(result.rows) > MAX_ROWS,
    }


async def _log_event(event_type: str, payload: dict) -> None:
    """Pipeline progress to stderr (`docker logs`), one JSON line per event; streamed text left out. Also the
    compact progress line the UI shows live (see _Progress)."""
    _PROGRESS.emit(event_type, payload)
    if event_type in ("agent_delta", "answer_delta"):
        return
    print(json.dumps({"event": event_type, **payload}, ensure_ascii=False, default=str), file=sys.stderr, flush=True)


def _short(value, limit: int = 160) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "…"


class _Progress:
    """The steps the UI shows while a question runs (packages/tool/data-studio-agent: kernel.ts reads these
    stdout lines, index.ts appends them to the session as `fox/data-studio-progress`). v3 and v4 events are
    reduced to one small shape — {t: step|part|agent|tool|sql|result|error, ...} — and the noisy or heavy ones
    (streamed text, traces, charts, timings) are left out. One question at a time per process."""

    def __init__(self) -> None:
        self._tools: dict[tuple, list[str]] = {}
        self._n = 0

    def reset(self) -> None:
        self._tools.clear()
        self._n = 0

    def _id(self) -> str:
        self._n += 1
        return f"p{self._n}"

    def emit(self, kind: str, p: dict) -> None:
        item = self._item(kind, p)
        if item is not None:
            item = {k: v for k, v in item.items() if v is not None}
            print(json.dumps({"progress": item}, ensure_ascii=False, default=str), flush=True)

    def _item(self, kind: str, p: dict) -> dict | None:
        part = p.get("part") or p.get("sub_id")
        owner = p.get("run_id") or f"{p.get('step_id')}:{p.get('agent')}"
        if kind == "step":  # v4: understand / find / plan / run / present
            return {"t": "step", "name": p.get("step"), "label": p.get("label"), "status": p.get("status"), "part": part}
        if kind == "decompose":  # v4
            return {"t": "parts", "parts": [{"id": x.get("id"), "question": x.get("question")} for x in p.get("parts") or []]}
        if kind == "decomposed":  # v3
            return {"t": "parts", "parts": [{"id": x.get("id"), "question": x.get("question")} for x in p.get("sub_questions") or []]}
        if kind in ("sub_started", "sub_done"):  # v3
            return {"t": "part", "id": p.get("sub_id"), "question": p.get("question"),
                    "status": "started" if kind == "sub_started" else ("done" if p.get("ok") else "failed")}
        if kind == "agent_started":
            return {"t": "agent", "id": owner, "agent": p.get("agent"), "label": p.get("label"), "status": "started", "part": part}
        if kind == "agent_done":
            ok = p.get("ok", True)
            return {"t": "agent", "id": owner, "agent": p.get("agent"), "status": "done" if ok else "failed",
                    "error": None if ok else _short(p.get("error") or "")}
        if kind == "tool_started":
            tid = p.get("call_id") or self._id()
            self._tools.setdefault((owner, p.get("tool")), []).append(tid)
            return {"t": "tool", "id": tid, "owner": owner, "tool": p.get("tool"), "args": _short(p.get("args") or {}, 120),
                    "status": "started", "part": part}
        if kind == "tool_done":
            pending = self._tools.get((owner, p.get("tool"))) or []
            tid = p.get("call_id") or (pending.pop(0) if pending else self._id())
            return {"t": "tool", "id": tid, "owner": owner, "tool": p.get("tool"), "status": "done",
                    "result": _short(p.get("result") or "", 160)}
        if kind == "sql":  # v4
            return {"t": "sql", "sql": _short(p.get("sql") or "", 2000), "part": part}
        if kind == "result":
            if "status" in p:  # v4
                return {"t": "result", "status": p.get("status"), "rows": p.get("row_count"), "error": p.get("error"), "part": part}
            return {"t": "sql", "sql": _short(p.get("sql") or "", 2000), "rows": p.get("row_count"), "part": part}  # v3
        if kind == "error":
            return {"t": "error", "text": _short(p.get("error") or "", 300), "part": part}
        return None


_PROGRESS = _Progress()


def _v4_trace(answer) -> str:
    """A short markdown trace for the tool result: each part's question and SQL, the notes, the timings."""
    lines = [f"**Pipeline v4** — {answer.presentation.status}"]
    if answer.standalone and answer.standalone != answer.question:
        lines.append(f"Question understood as: {answer.standalone}")
    for p in answer.parts:
        lines.append(f"\n**{p.id}.** {p.question}")
        if p.sql:
            lines.append(f"```sql\n{p.sql}\n```")
        if p.error:
            lines.append(f"Error: {p.error}")
    for note in [*answer.notes, *answer.presentation.notes, *answer.presentation.warnings]:
        lines.append(f"- {note}")
    seconds = (answer.timings or {}).get("seconds")
    if seconds is not None:
        lines.append(f"\nTotal: {seconds} s")
    return "\n".join(lines)


async def handle_v4(question: str, owner: dict | None = None) -> dict:
    """The same reply as `handle()`, from pipeline v4 (src/pipeline_v4/answer.py ask_v4). Stateless per question
    like v3: fox's session log carries the conversation, so no conversation_id goes in. The answer is still saved
    (save_answer) because that is what gives each chart a document a dashboard can pin."""
    answer = await ask_v4(question, get_settings(), _log_event)
    shown = answer.presentation
    if shown.status == "clarify":
        options = "".join(f"\n- {o}" for o in shown.options)
        return {"ok": False, "error": f"Cần làm rõ câu hỏi: {shown.answer_markdown}{options}"}
    if shown.status == "failed":
        return {"ok": False, "error": shown.answer_markdown or "pipeline v4 thất bại không rõ lý do"}

    conversation_id, _, chart_ids = await save_answer(get_async_mongo_db(), answer, None)
    _stamp_owner(get_mongo_db(), conversation_id, list(chart_ids), owner or {})
    charts = []
    for chart, chart_id in zip(shown.charts, chart_ids):
        spec = chart_spec(chart)
        charts.append({
            "type": spec["type"], "x": spec["x"], "y": spec["y"], "value_field": spec["value_field"],
            "title": spec["title"], "description": "", "recommended": bool(chart.get("recommended")),
            "rows": (spec["rows"] or [])[:MAX_ROWS], "chart_id": chart_id,
        })
    first = next((p for p in answer.parts if p.sql and p.result is not None), None)
    rows = list(first.result.rows) if first else []
    return {
        "ok": True,
        "answer": shown.answer_markdown,
        "sql": first.sql if first else None,
        "columns": [c.name for c in first.result.columns] if first else [],
        "rows": rows[:MAX_ROWS],
        "row_count": first.result.row_count if first else 0,
        "trace_md": _v4_trace(answer),
        "charts": charts,
        "chart": next((c for c in charts if c["type"] != "table"), None),
        "chart_id": next((c["chart_id"] for c in charts if c["type"] != "table"), None),
        "follow_up_questions": [f["question"] for f in shown.follow_ups if f.get("question")],
        "assumptions": list(answer.notes),
        "truncated": len(rows) > MAX_ROWS,
    }


async def main() -> None:
    settings = get_settings()
    if not check_mongo_connection():
        raise RuntimeError('MongoDB is unreachable — set MONGODB_URL (or MongoDBWrite) and MONGODB_DATABASE_NAME')
    ensure_indexes()
    print(json.dumps({"event": "pipeline", "pipeline": PIPELINE}), file=sys.stderr, flush=True)
    llm = LLMClient(settings)
    emb = EmbeddingClient(settings)
    vs = MeiliStore(settings)
    dremio = DremioClient(settings)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request = json.loads(line)
        # The role of the conversation's owner (packages/tool/data-studio-agent/src/index.ts: gateway ->
        # runtime -> tool, never from the model). Set per question: this one process answers every user's
        # questions in turn. Anything unexpected falls back to "user" (least privilege), see src/security/role.py.
        # begin_question also notes which data sources an admin switched off: their tables are out for every role.
        role_mod.begin_question(get_mongo_db(), request.get("role", role_mod.USER))
        _PROGRESS.reset()
        try:
            owner = {"user_id": request.get("user_id"), "session_id": request.get("session_id")}
            if PIPELINE == "v4":
                reply = await handle_v4(request["question"], owner)
            else:
                reply = await handle(request["question"], llm, emb, vs, dremio, owner)
        except Exception as e:  # noqa: BLE001 — surface any crash to the TS side instead of dying
            # Real gap found debugging a live "[Errno 111] Connection refused"
            # with zero context: `str(e)` alone doesn't say WHICH of
            # LLM/embedding/Dremio/Meilisearch refused — the traceback's
            # deepest frames do. Goes to the model (then the user), same as
            # `str(e)` did before; a bit more tokens on the rare error path
            # is worth being able to actually diagnose it.
            #
            # 2026-09-18: this used to be invisible until the reply printed below —
            # a hard crash produced ZERO output on stderr, so `docker logs` stayed
            # silent for the tool's entire remaining (killed) run. Print immediately
            # so the crash shows up live, same as every `_trace()` milestone/warning.
            tb = traceback.format_exc()
            print(json.dumps({"event": "crash", "error": str(e), "traceback": tb[-2000:]},
                              ensure_ascii=False), file=sys.stderr, flush=True)
            reply = {"ok": False, "error": f"{e}\n{tb[-2000:]}"}
        print(json.dumps(reply, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
