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
   "row_count": int, "trace_md": str, "chart": {...}|None, "chart_id": int|None,
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

from sqlmodel import Session

from src.database.engine import create_db_and_tables, engine
from src.database.models import Chart, Conversation, Message, QueryResult
from src.database.models.enums import MessageRole
from src.pipeline_v3.orchestrator import run_pipeline_v3
from src.services.dremio_client import DremioClient
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.meili_store import MeiliStore
from src.settings import get_settings

# Cap what's handed back to the model/UI; a full result can be thousands of rows.
MAX_ROWS = 200


def _persist_chart(session: Session, question: str, result, chart: dict | None) -> int | None:
    """Minimal Conversation->Message->QueryResult->Chart chain so `chart` (already
    computed by `handle()` below) has a real row a dashboard widget can reference.
    Returns the new Chart's id, or None if there's no chart to persist."""
    if chart is None:
        return None
    conversation = Conversation(title=question[:120])
    session.add(conversation)
    session.flush()
    message = Message(
        conversation_id=conversation.id,
        seq=0,
        role=MessageRole.ASSISTANT,
        content=result.answer_markdown,
        question=question,
        answer_markdown=result.answer_markdown,
    )
    session.add(message)
    session.flush()
    query_result = QueryResult(
        message_id=message.id,
        seq=0,
        sql=result.sql,
        row_count=result.row_count,
        rows_json=result.rows[:MAX_ROWS],
    )
    session.add(query_result)
    session.flush()
    chart_row = Chart(
        query_result_id=query_result.id,
        type=chart.get("type", "bar"),
        title=chart.get("title") or "",
        x=chart.get("x"),
        y_json=chart.get("y") or [],
        recommended=bool(chart.get("recommended")),
        rows_json=chart.get("rows") or [],
    )
    session.add(chart_row)
    session.commit()
    return chart_row.id


async def handle(question: str, llm: LLMClient, emb: EmbeddingClient, vs: MeiliStore, dremio: DremioClient) -> dict:
    events: list[tuple[str, dict]] = []

    async def on_event(event_type: str, payload: dict) -> None:
        events.append((event_type, payload))

    with Session(engine) as session:
        result = await run_pipeline_v3(session, llm, emb, vs, dremio, question, on_event=on_event)

    if result.needs_clarification:
        return {"ok": False, "error": f"Cần làm rõ câu hỏi: {result.clarifying_question}"}
    if not result.success:
        return {"ok": False, "error": result.error or "pipeline thất bại không rõ lý do"}

    # First non-table chart, if any — the reviewed list always ends with a raw-data
    # table entry (orchestrator.py's _run_charts_stage), which the caller already
    # gets via `rows`/`columns`.
    chart = next((c for c in result.charts if c.get("type") != "table"), None)
    chart_id = None
    if chart is not None:
        with Session(engine) as persist_session:
            chart_id = _persist_chart(persist_session, question, result, chart)

    return {
        "ok": True,
        "answer": result.answer_markdown,
        "sql": result.sql,
        "columns": list(result.rows[0].keys()) if result.rows else [],
        "rows": result.rows[:MAX_ROWS],
        "row_count": result.row_count,
        "trace_md": result.trace_md,
        "chart": chart,
        "chart_id": chart_id,
        "truncated": len(result.rows) > MAX_ROWS,
    }


async def main() -> None:
    settings = get_settings()
    create_db_and_tables()
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
            reply = {"ok": False, "error": f"{e}\n{traceback.format_exc()[-2000:]}"}
        print(json.dumps(reply, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
