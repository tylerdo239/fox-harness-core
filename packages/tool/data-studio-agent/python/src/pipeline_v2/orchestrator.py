"""pipeline_v2 orchestrator — drives steps 0→8 over one accumulating state ticket.

Contract mirrors v1's run_pipeline (same packaged dict shape) so chat.py can swap between
them behind a flag. After each step that can surface a ClarificationNeeded, a gate checks
whether to stop and ask the user instead of guessing. On a generation/execution failure the
whole chain re-runs once from step 0 with the failure noted (v2 keeps retry coarse for now;
v1's fine-grained step-routing can be ported later if needed).
"""

import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from sqlmodel import Session

from src.pipeline_v2.state import PipelineState
from src.pipeline_v2.step0_intent import run_step0
from src.pipeline_v2.step1_entities import run_step1
from src.pipeline_v2.step2_terms import run_step2
from src.pipeline_v2.step3_grain import run_step3
from src.pipeline_v2.step4_select import run_step4
from src.pipeline_v2.step5_filters import run_step5
from src.pipeline_v2.step6_joins import run_step6
from src.pipeline_v2.step7_edges import run_step7
from src.pipeline_v2.step8_generate import GenerateResult, run_step8
from src.pipeline_v2.step9_enrich import _build_display_columns
from src.pipeline_v2.enrich_charts import recommend_charts
from src.pipeline_v2.enrich_followups import generate_followups
from src.pipeline_v2.enrich_insights import stream_insights
from src.services.dremio_client import DremioClient
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.vector_store import VectorStore

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 2
DEBUG_DIR = Path("debug_logs_v2")

# on_event(type, payload). Types: step_started, step_completed, result, insights, charts,
# follow_ups, clarification_needed, error, done. The default no-op sink lets callers that want
# only the final dict ignore streaming entirely.
EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]


async def _noop(_type: str, _payload: dict[str, Any]) -> None:
    return None


# the ordered pipeline steps, for progress events (deterministic labels the UI can map)
_STEPS = [
    ("step0", "Understanding the question"),
    ("step1", "Finding tables"),
    ("step2", "Resolving business terms"),
    ("step3", "Determining grain"),
    ("step4", "Planning metrics & grouping"),
    ("step5", "Applying filters"),
    ("step6", "Resolving joins"),
    ("step7", "Finalizing query"),
    ("step8", "Running query"),
]


async def run_pipeline_v2_decomposed(
    session: Session,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    dremio_client: DremioClient,
    question: str,
    on_event: EventSink = _noop,
) -> dict[str, Any]:
    """Top-level entry: decompose the question first. A single-part question runs the normal
    single pipeline unchanged. A multi-part question runs its sub-question DAG (parallel where
    independent, sequential where dependent), each sub-question keeping its OWN chart, then one
    combined short_answer + insights is produced over all sub-results.

    SSE event shape for the multi-part case: a 'decomposed' event lists the sub-questions; each
    sub-question then streams its own step/result/charts/insights events tagged with `sub_id`;
    finally a 'combined_insights' event carries the synthesis, then 'done'."""
    # local imports avoid an import cycle (runner/combine don't import the orchestrator)
    from src.pipeline_v2.combine_results import stream_combined
    from src.pipeline_v2.decompose_runner import run_dag
    from src.pipeline_v2.decompose_v2 import decompose_v2

    decomposition = await decompose_v2(session, llm_client, question)

    if not decomposition.is_multi_part:
        # simple question — no decomposition overhead, run the single pipeline directly
        return await run_pipeline_v2(
            session, llm_client, embedding_client, vector_store, dremio_client, question, on_event=on_event
        )

    subs = decomposition.sub_questions
    await on_event("decomposed", {
        "sub_questions": [{"id": s.id, "question": s.question, "depends_on": s.depends_on} for s in subs],
    })

    # each sub-question runs the full pipeline (enrich=True → its own chart); DAG handles ordering
    async def run_one(session_, llm_, emb_, vs_, dremio_, q_, on_event):  # noqa: ANN001
        return await run_pipeline_v2(session_, llm_, emb_, vs_, dremio_, q_, enrich=True, on_event=on_event)

    results = await run_dag(
        session, llm_client, embedding_client, vector_store, dremio_client, subs, run_one, on_event
    )

    ordered = [(s.id, results.get(s.id, {})) for s in subs]
    # stream the combined answer+insights as markdown ('combined_delta' events)
    await on_event("combined_started", {})
    combined_md = await stream_combined(llm_client, question, ordered, on_event)
    await on_event("combined_done", {"answer_markdown": combined_md})
    await on_event("done", {})

    return {
        "question": question,
        "success": any(r.get("success") for _, r in ordered),
        "decomposed": True,
        "sub_results": [{"id": sid, **r} for sid, r in ordered],
        "answer_markdown": combined_md,
        "pipeline": "v2",
    }


async def run_pipeline_v2(
    session: Session,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    dremio_client: DremioClient,
    question: str,
    enrich: bool = True,
    on_event: EventSink = _noop,
) -> dict[str, Any]:
    """Runs the pipeline, emitting progress + result + enrichment events via on_event as they
    complete, and also returning the final packaged dict. The SSE endpoint streams the events;
    a plain caller can ignore on_event and use the return value."""
    logger.info("pipeline_v2 start question=%r", question)

    async def step(idx: int) -> None:
        key, label = _STEPS[idx]
        await on_event("step_started", {"step": key, "label": label})

    async def step_done(idx: int, data: dict[str, Any] | None = None) -> None:
        key, _ = _STEPS[idx]
        await on_event("step_completed", {"step": key, "data": data or {}})

    last_state: PipelineState | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        state = PipelineState(question=question)
        last_state = state

        await step(0)
        await run_step0(llm_client, state)
        await step_done(0)

        await step(1)
        await run_step1(session, llm_client, embedding_client, vector_store, state)
        await step_done(1, {"entity_ids": list(state.target_entity_ids)})
        if _gate(state, "entities"):
            packaged = _package_clarify(state)
            await on_event("clarification_needed", packaged)
            await on_event("done", {})
            return packaged

        await step(2)
        await run_step2(session, llm_client, embedding_client, vector_store, state)
        await step_done(2, {"business_rules": [r.term for r in state.business_rules]})

        await step(3)
        await run_step3(session, llm_client, state)
        await step_done(3, {"grain": state.grain})

        await step(4)
        await run_step4(session, llm_client, state)
        await step_done(4)

        await step(5)
        await run_step5(session, llm_client, state)
        await step_done(5)

        await step(6)
        run_step6(session, state)
        await step_done(6, {"strategy": state.join_plan.strategy.value if state.join_plan else None})
        if _gate(state, "joins"):
            packaged = _package_clarify(state)
            await on_event("clarification_needed", packaged)
            await on_event("done", {})
            return packaged

        run_step7(session, state)

        await step(8)
        result = run_step8(session, dremio_client, state)
        _dump_state(state, attempt, result)

        if result.success:
            logger.info("pipeline_v2 done attempt=%d sql=%r", attempt, result.sql)
            await step_done(8, {"row_count": result.execution.row_count if result.execution else 0})
            packaged = _package_success(state, result)

            # emit the table result first, so the UI can render it immediately...
            await on_event("result", packaged)

            if enrich:
                # ...then enrich progressively, emitting each part as it finishes so the UI
                # fills in fastest-first: charts (pure code) → insights (LLM) → follow-ups (LLM).
                await _enrich_streaming(
                    session, llm_client, state, result.sql or "",
                    packaged["rows"], packaged["row_count"], packaged, on_event,
                )

            await on_event("done", {})
            return packaged

        logger.warning("pipeline_v2 attempt=%d failed: %s", attempt, result.error)
        await on_event("error", {"step": "step8", "message": result.error})
        state.add_assumption(f"Attempt {attempt} failed: {result.error}")

    packaged = _package_failure(last_state)
    await on_event("clarification_needed", packaged)
    await on_event("done", {})
    return packaged


async def _enrich_streaming(
    session: Session,
    llm_client: LLMClient,
    state: PipelineState,
    sql: str,
    rows: list[dict[str, Any]],
    row_count: int,
    packaged: dict[str, Any],
    on_event: EventSink,
) -> None:
    """Run the 3 enrichment parts individually, emitting each as soon as it's ready and folding
    it into `packaged` (so the non-streaming return value is complete too). Each part is
    isolated — a failure in one never blocks the others or the already-sent table result."""
    display_columns = _build_display_columns(session, state)
    packaged["display_columns"] = display_columns

    # charts — LLM proposes type+fields, code validates + guarantees >=1 chart (an LLM call now)
    try:
        specs = await recommend_charts(llm_client, state.question, display_columns, rows)
        charts = [c.to_dict() for c in specs]
    except Exception:  # noqa: BLE001
        charts = []
    packaged["charts"] = charts
    await on_event("charts", {"charts": charts, "display_columns": display_columns})

    # insights — streamed markdown (token deltas via 'insights_delta'); the DAG's sub_sink tags
    # each delta with sub_id, so per-sub insights land in the right sub-question section.
    await on_event("insights_started", {})
    try:
        answer_md = await stream_insights(
            llm_client, state.question, sql, display_columns, rows, row_count, on_event,
        )
    except Exception:  # noqa: BLE001
        answer_md = ""
    packaged["answer_markdown"] = answer_md
    await on_event("insights_done", {"answer_markdown": answer_md})

    # follow-ups — another LLM call
    try:
        fu = await generate_followups(session, llm_client, state)
        packaged["follow_up_questions"] = fu.questions
    except Exception:  # noqa: BLE001
        packaged["follow_up_questions"] = []
    await on_event("follow_ups", {"follow_up_questions": packaged["follow_up_questions"]})


def _gate(state: PipelineState, slot: str) -> bool:
    """Stop and clarify if this step raised a clarification. Returns True when the pipeline
    should halt and ask the user."""
    return any(c.slot == slot for c in state.clarifications)


def _pretty_sql(sql: str | None) -> str | None:
    """Format the one-line generated SQL into readable multi-line for the UI. Tries SQLGlot's
    pretty-printer first; if that can't parse the string (some glossary fragments use
    Dremio-specific syntax like TRY_CONVERT_FROM(... AS ROW(...))), falls back to a simple
    keyword-based line break so the UI still shows multi-line SQL instead of one long line."""
    if not sql:
        return sql
    try:
        import sqlglot
        return sqlglot.transpile(sql, pretty=True)[0]
    except Exception:  # noqa: BLE001
        return _linebreak_keywords(sql)


def _linebreak_keywords(sql: str) -> str:
    """Cheap fallback formatter: put major SQL clauses on their own lines."""
    import re
    # newline before each top-level clause keyword (word-boundary, case-insensitive)
    for kw in ("FROM", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "JOIN", "WHERE",
               "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "UNION"):
        sql = re.sub(rf"\s+{re.escape(kw)}\s+", f"\n{kw} ", sql, flags=re.IGNORECASE)
    return sql


def _package_success(state: PipelineState, result: GenerateResult) -> dict[str, Any]:
    execution = result.execution
    return {
        "question": state.question,
        "success": True,
        "sql": _pretty_sql(result.sql),
        "rows": execution.rows if execution else [],
        "row_count": execution.row_count if execution else 0,
        "assumptions": state.assumptions,
        "sanity_warnings": [f.message for f in execution.sanity_flags] if execution else [],
        "join_strategy": state.join_plan.strategy.value if state.join_plan else None,
        "pipeline": "v2",
    }


def _package_clarify(state: PipelineState) -> dict[str, Any]:
    questions = [c.question for c in state.clarifications]
    return {
        "question": state.question,
        "success": False,
        "clarifying_question": " ".join(questions) if questions else "Could you clarify the question?",
        "assumptions": state.assumptions,
        "pipeline": "v2",
    }


def _package_failure(state: PipelineState | None) -> dict[str, Any]:
    return {
        "question": state.question if state else "",
        "success": False,
        "clarifying_question": "I couldn't build a valid query for this. Could you rephrase or add detail?",
        "assumptions": state.assumptions if state else [],
        "pipeline": "v2",
    }


def _dump_state(state: PipelineState, attempt: int, result: GenerateResult) -> None:
    """Dev-only: snapshot the full state ticket + generated SQL for each attempt. Never raises."""
    try:
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        path = DEBUG_DIR / f"state_attempt_{attempt}.json"
        payload = state.to_debug_dict()
        payload["generated_sql"] = result.sql
        payload["step8_error"] = result.error
        path.write_text(json.dumps(payload, indent=2, default=str, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
