"""JSON-lines bridge for the `analyze_data` tool (packages/tool/data-studio-agent).

Same protocol shape as packages/tool/python-repl/python/runner.py: one process per
worker container, started lazily on the first tool call and reused across turns.
Wraps `run_pipeline_v3` (src/pipeline_v3/orchestrator.py) directly — it is a plain
async function, only ever wrapped in FastAPI/SSE for the reference app's own web UI.
No HTTP, no auth here: this process only ever talks to its own parent (the Node
worker) over a private stdio pipe, never the network.

`run_pipeline_v3` is stateless per question (no conversation_id/history) — fox's own
session log is what carries multi-turn context; each call here is independent.

stdin:  one {"question": str} per line
stdout: one JSON reply per line:
  {"ok": true, "answer": str, "sql": str|None, "columns": [str], "rows": [...],
   "row_count": int, "trace_md": str, "charts": [{type,x,y,title,recommended,rows,chart_id}],
   "chart": {...}|None, "chart_id": str|None, "follow_up_questions": [str], "assumptions": [str],
   "truncated": bool}
  or {"ok": false, "error": str}

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
import sys
import traceback
from pathlib import Path

# Python puts the SCRIPT's own directory (bridge/) on sys.path, not the CWD —
# so `src.*` (this service's package root, one level up) needs adding by hand.
# Kept independent of CWD since the TS kernel (packages/tool/data-studio-agent)
# invokes this by absolute path, same as packages/tool/python-repl's runner.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.crud_mongo import conversation as conversation_crud
from src.database.models.enums import MessageRole
from src.database.mongodb import AttrDatabase, check_mongo_connection, ensure_indexes, get_mongo_db
from src.pipeline_v3.orchestrator import run_pipeline_v3
from src.services.dremio_client import DremioClient
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.meili_store import MeiliStore
from src.settings import get_settings

# Cap what's handed back to the model/UI; a full result can be thousands of rows.
MAX_ROWS = 200


def _persist_charts(db: AttrDatabase, question: str, result, charts: list[dict]) -> list[str]:
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
    return [
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


async def handle(question: str, llm: LLMClient, emb: EmbeddingClient, vs: MeiliStore, dremio: DremioClient) -> dict:
    # Milestone progress (which agent/step/tool is running right now) AND every retry/
    # warning/error (orchestrator.py's `_trace()`, 2026-09-18 — "log hết"), one JSON line
    # per event on stderr — kernel.ts forwards each line straight to the worker
    # container's own stdout/stderr, so `docker logs -f` shows live pipeline
    # progress instead of nothing until the final reply. `agent_delta` is excluded:
    # it's a token-by-token content stream (SSE UI use case), far too noisy for a log.
    async def on_event(event_type: str, payload: dict) -> None:
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
    chart_ids = _persist_charts(db, question, result, answer_charts)
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


async def main() -> None:
    settings = get_settings()
    if not check_mongo_connection():
        raise RuntimeError('MongoDB is unreachable — set MONGODB_URL (or MongoDBWrite) and MONGODB_DATABASE_NAME')
    ensure_indexes()
    llm = LLMClient(settings)
    emb = EmbeddingClient(settings)
    vs = MeiliStore(settings)
    dremio = DremioClient(settings)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request = json.loads(line)
        try:
            reply = await handle(request["question"], llm, emb, vs, dremio)
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
