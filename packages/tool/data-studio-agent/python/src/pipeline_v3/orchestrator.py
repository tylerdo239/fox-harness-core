"""pipeline_v3 vertical slice orchestrator.

Sequences the slice: Intake → Retrieval → Grain → Metric → Slice → Compile → Execute.
Each LLM-driven step is a Worker→Parser agent (base.WorkerParserAgent); the deterministic
steps (join planning, AST compile, validate, execute) reuse pipeline_v2 code verbatim.

The one loop back-edge in this slice: after Execute, a grain_check inspects the result. If
the breakdown collapsed (rows==1 when grouping was asked) or every metric value is identical
(the all-1s bug), it routes back to Slice ONCE with the flag, then accepts or declines. This
is the self-correction the FSM couldn't do — the whole reason for the loop.

Everything the agents produce as markdown is concatenated into `trace_md`.
"""

from __future__ import annotations

import asyncio
import contextvars
import uuid
from dataclasses import dataclass, field

import pandas as pd
from sqlmodel import Session, select

from src.database.engine import engine

from src.database.models import Entity, EntityColumn
from src.database.models.enums import ColumnRole
from src.pipeline_v2.state import (
    BusinessRule,
    DimensionSpec,
    EntityMatch,
    FilterSpec,
    MetricSpec,
    PipelineState,
    TimeSpec,
)
from src.pipeline_v2.step6_joins import run_step6
from src.pipeline_v2.step8_generate import run_step8
from src.pipeline_v3.agents import (
    build_chart_agent,
    build_chart_review_agent,
    build_clarify_agent,
    build_compose_agent,
    build_decompose_agent,
    build_filter_agent,
    build_grain_agent,
    build_insight_agent,
    build_intake_agent,
    build_metric_agent,
    build_rank_agent,
    build_review_agent,
    build_slice_agent,
    build_transform_agent,
    render_candidates_block,
)
from src.pipeline_v3.base import EventSink, WorkerParserAgent
from src.pipeline_v3.pandas_exec import run_pandas_code
from src.pipeline_v3.resolve import NameResolver
from src.pipeline_v3.schemas import FilterOut, GrainOut, IntakeOut, MetricOut, SliceOut
from src.services.dremio_client import DremioClient
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.schema_linking import (
    RetrievalResult,
    _best_label_column,
    retrieve_candidates,
)
from src.services.vector_store import VectorStore


@dataclass
class V3Result:
    success: bool
    sql: str | None = None
    rows: list[dict] = field(default_factory=list)
    row_count: int = 0
    trace_md: str = ""
    assumptions: list[str] = field(default_factory=list)
    error: str | None = None
    grain_backedge_fired: bool = False
    answer_markdown: str = ""
    charts: list[dict] = field(default_factory=list)
    follow_up_questions: list[str] = field(default_factory=list)
    transform_ops: list[str] = field(default_factory=list)
    question: str = ""
    needs_clarification: bool = False
    clarifying_question: str = ""
    clarify_options: list[str] = field(default_factory=list)
    # for a decomposed question: each sub-question's own question + result, so the final Review can
    # judge the WHOLE answer (all parts) instead of only the merged view — a merge can hide a part
    # and make Review wrongly conclude "missing". Each: {question, success, row_count, columns, rows}.
    sub_results: list[dict] = field(default_factory=list)


# The streaming sink is carried in a contextvar so it doesn't have to be threaded through every
# helper's signature. Set once at pipeline entry; read by _emit + _run_agent. Defaults to None
# (no streaming) so a plain caller — a test, the shadow-diff runner — works unchanged.
_SINK: contextvars.ContextVar[EventSink | None] = contextvars.ContextVar("v3_sink", default=None)
# The id of the sub-question currently being processed (None at the top level). Every event emitted
# while it is set is tagged with `sub_id` so the UI can group each sub-question's steps — this is what
# makes PARALLEL sub-question runs legible (their events interleave on one SSE stream).
_SUB_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar("v3_sub_id", default=None)
# A UNIQUE id for the agent step currently running. Every event it emits (agent_started/done,
# tool_started/done, agent_delta) carries this id so the UI attributes them to the RIGHT step even
# when parallel sub-questions run the same-named agents concurrently (matching by agent NAME races).
_STEP_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar("v3_step_id", default=None)


async def _emit(event_type: str, payload: dict) -> None:
    sink = _SINK.get()
    if sink is not None:
        sub_id = _SUB_ID.get()
        if sub_id is not None and "sub_id" not in payload:
            payload = {**payload, "sub_id": sub_id}
        step_id = _STEP_ID.get()
        if step_id is not None and "step_id" not in payload:
            payload = {**payload, "step_id": step_id}
        await sink(event_type, payload)


# 2026-09-18 (user report: "log hết" — retries/warnings/errors folded into `trace`/`trace_md` only
# surfaced in the FINAL reply, not live; e.g. a sub-question retry or a chart-review rejection was
# invisible in `docker logs` while the run was still in progress). Every `trace.append()` in this
# file now goes through this instead: same list mutation, PLUS an immediate 'trace' event when a
# sink is attached — runner.py's on_event prints it straight to stderr, which kernel.ts (TS side)
# forwards live to the worker container's own stdout. `create_task` (fire-and-forget, not awaited):
# called from both async step functions AND plain `def` helpers (_ensure_grain_dimension,
# _force_grain_only_dims, _fail) that have no `await` of their own to hang this on — safe here
# because every caller in this module only ever runs on the one thread already driving asyncio.run()
# in bridge/runner.py's main(), so a running loop always exists to schedule onto.
def _trace(trace: list[str], text: str) -> None:
    trace.append(text)
    if _SINK.get() is not None:
        asyncio.create_task(_emit("trace", {"text": text}))


# Human-readable step labels for the UI ("AI is running: Deciding the grain").
_STEP_LABELS = {
    "decompose": "Splitting the question",
    "intake": "Understanding the question",
    "rank": "Checking for ranking",
    "clarify": "Checking clarity",
    "grain": "Deciding the grain",
    "metric": "Choosing what to measure",
    "slice": "Choosing the breakdown",
    "filter": "Applying filters",
    "transform": "Computing derived values",
    "insight": "Writing the answer",
    "chart": "Choosing a chart",
    "field": "Picking chart fields",
    "chart_review": "Reviewing the chart",
    "followups": "Suggesting follow-ups",
    "compose": "Merging results",
    "review": "Reviewing the answer",
}


async def _run_agent(agent: WorkerParserAgent, prompt: str):
    """Run an agent with start/done streaming events + live tool/markdown streaming (via the
    contextvar sink). Returns the AgentRun. Each call gets a UNIQUE step_id (via the _STEP_ID
    contextvar) so all its events — including the tool/delta events base.py emits straight to the
    sink — are attributable to THIS step, even under parallel sub-questions running the same agents."""
    _STEP_ID.set(uuid.uuid4().hex)
    label = _STEP_LABELS.get(agent.name, agent.name)
    await _emit("agent_started", {"agent": agent.name, "label": label})
    # pass _emit (NOT the raw sink) so the tool_started/tool_done/agent_delta events base.py fires
    # go through the same tagging — they get this step's step_id + the current sub_id, so the UI can
    # attach each tool call to the RIGHT step even under parallel sub-questions.
    run = await agent.run(prompt, on_event=(_emit if _SINK.get() is not None else None))
    await _emit("agent_done", {"agent": agent.name, "ok": run.ok})
    return run


def _debug_dump(question: str, result: V3Result) -> None:
    """Persist every step's markdown + the final result to a debug folder so a bad run can be
    inspected offline. Controlled by env DATA_STUDIO_V3_DEBUG (default ON in dev); best-effort —
    a dump failure never breaks the pipeline. One file per run, timestamped."""
    import os

    if os.getenv("DATA_STUDIO_V3_DEBUG", "1") == "0":
        return
    try:
        from datetime import datetime
        from pathlib import Path

        debug_dir = Path(__file__).resolve().parents[2] / "debug" / "pipeline_v3"
        debug_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        safe_q = "".join(c if c.isalnum() or c in " -_" else "_" for c in question)[:60].strip()
        path = debug_dir / f"{ts}__{safe_q or 'query'}.md"

        subs = ""
        if result.sub_results:
            subs = "\n## Sub-results\n" + "\n".join(
                f"- **{s['question']}** → {s['row_count']} rows, cols {s['columns']}"
                for s in result.sub_results
            )
        header = (
            f"# Pipeline v3 run\n\n"
            f"- **question:** {question}\n"
            f"- **time:** {datetime.now().isoformat()}\n"
            f"- **success:** {result.success}\n"
            f"- **needs_clarification:** {result.needs_clarification}"
            f"{f' — {result.clarifying_question}' if result.needs_clarification else ''}\n"
            f"- **error:** {result.error}\n"
            f"- **row_count:** {result.row_count}\n"
            f"- **grain_backedge_fired:** {result.grain_backedge_fired}\n"
            f"- **sql:** \n```sql\n{result.sql or ''}\n```\n"
            f"- **columns:** {list(result.rows[0].keys()) if result.rows else []}\n"
            f"- **first rows:** {result.rows[:5]}\n"
            f"{subs}\n\n"
            f"---\n\n# Step trace\n\n"
        )
        path.write_text(header + (result.trace_md or ""), encoding="utf-8")
    except Exception as e:  # never let debugging break a run
        import logging
        logging.getLogger(__name__).warning("v3 debug dump failed: %s", e)


async def run_pipeline_v3(
    session: Session,
    llm: LLMClient,
    emb: EmbeddingClient,
    vs: VectorStore,
    dremio: DremioClient,
    question: str,
    on_event: EventSink | None = None,
) -> V3Result:
    """Full pipeline with a final Review gate.

    Build the answer (decompose → sub-runs → compose → transform → insight), then a Review agent
    judges it AS A USER. If not satisfied, re-plan ONCE with the feedback + old result injected,
    then return the better of the two (satisfied wins; else the retry).

    `on_event(type, payload)` streams progress (agent_started/done, tool_started/done, agent_delta,
    result, insight_delta, chart, clarification, error, done) to the UI over SSE.
    """
    _SINK.set(on_event)
    model = llm._model
    trace: list[str] = []

    result = await _build_answer(session, llm, emb, vs, dremio, question, trace, feedback="")
    result.question = question
    if result.needs_clarification or not result.success:
        result.trace_md = "\n\n---\n\n".join(trace)
        _debug_dump(question, result)
        if result.needs_clarification:
            await _emit("clarification", {
                "question": result.clarifying_question, "options": result.clarify_options,
            })
        else:
            await _emit("error", {"error": result.error or "pipeline failed"})
        await _emit("done", {})
        return result

    # ── Review — only when there is real risk of an incomplete answer ─────────
    # A single-metric per-group question that returned rows is almost never wrong in a way a
    # subjective re-read catches — and the weak model over-fires Review, restarting the whole
    # chain. So only review when the question COMPARES/lists several things (multi-metric) or the
    # result is empty. Everything else finalizes directly.
    if not _should_review(result):
        result.trace_md = "\n\n---\n\n".join(trace)
        return await _finalize(result)

    review_agent = build_review_agent(model)
    # For a decomposed question the merged rows can hide a part — give Review EACH sub-question's own
    # result too, so it judges the WHOLE answer (every part present?) not just the merged view.
    subs_block = ""
    if result.sub_results:
        def _sub_line(i: int, s: dict) -> str:
            if not s.get("success") or not s.get("row_count"):
                return (f"- Sub {i + 1}: \"{s['question']}\" → **FAILED / 0 rows** "
                        f"(error: {s.get('error') or 'no rows'}). This part is MISSING — not satisfied.")
            return (f"- Sub {i + 1}: \"{s['question']}\" → {s['row_count']} rows, "
                    f"columns {s['columns']}, sample {s['rows'][:3]}")
        parts = [_sub_line(i, s) for i, s in enumerate(result.sub_results)]
        subs_block = (
            "\nThis question was split into parts; EACH part's own result is below. Judge whether "
            "ALL parts together answer the original question — a part is present if its sub-result "
            "has rows. Do NOT conclude 'missing' for something that appears in a sub-result.\n"
            + "\n".join(parts) + "\n"
        )
    rev_run = await _run_agent(review_agent,
        f"Original question: {question}\n\n"
        f"Answer given:\n{result.answer_markdown}\n\n"
        f"Combined result columns: {list(result.rows[0].keys()) if result.rows else []}\n"
        f"Combined rows ({result.row_count}): {result.rows[:10]}\n"
        f"{subs_block}"
    )
    _trace(trace, rev_run.markdown)
    if not rev_run.ok or rev_run.result.satisfied:
        result.trace_md = "\n\n---\n\n".join(trace)
        return await _finalize(result)

    # not satisfied → one re-plan carrying the feedback + old result as context
    fb = rev_run.result.feedback or ", ".join(rev_run.result.missing)
    _trace(trace, f"## Review\n- ⚠️ not satisfied: {fb} → re-planning once with feedback")
    feedback_ctx = (
        f"A previous attempt was judged incomplete. Feedback: {fb}. "
        f"Missing: {rev_run.result.missing}. Previous result columns: "
        f"{list(result.rows[0].keys()) if result.rows else []}. "
        f"Make sure the new answer addresses this."
    )
    retry = await _build_answer(session, llm, emb, vs, dremio, question, trace, feedback=feedback_ctx)
    retry.trace_md = "\n\n---\n\n".join(trace)
    return await _finalize(retry if retry.success else result)


async def _finalize(result: V3Result) -> V3Result:
    """Emit the terminal streaming events (result table, chart, answer, done) then return."""
    _debug_dump(result.question, result)
    await _emit("result", {
        "sql": result.sql, "rows": result.rows, "row_count": result.row_count,
        "assumptions": result.assumptions,
    })
    if result.answer_markdown:
        await _emit("answer", {"answer_markdown": result.answer_markdown})
    if result.charts:
        await _emit("charts", {"charts": result.charts})
    # re-emit follow-ups AFTER the result re-emit so they aren't wiped by it
    if result.follow_up_questions:
        await _emit("follow_ups", {"follow_up_questions": result.follow_up_questions})
    await _emit("done", {})
    return result


def _should_review(result: V3Result) -> bool:
    """Only run the Review→re-plan gate when there is a real completeness risk: an empty result, or
    a COMPARE/multi-metric question (several numeric columns) where a sub-result could be missing.
    A single-metric per-group answer with rows skips Review, so the weak model can't spuriously
    restart the whole pipeline on a correct answer."""
    if not result.rows:
        return True
    ql = result.question.lower()
    if any(w in ql for w in ("so sánh", "compare")):
        return True
    # count NUMERIC MEASURE columns — exclude id/key columns (an id is not a measure, and uuid
    # strings aren't numeric anyway). Two+ real measures = a comparison that could be half-answered.
    measure_cols = sum(
        1 for k, v in result.rows[0].items()
        if _norm_num(v) is not None and not k.lower().endswith("_id") and k.lower() != "id"
    )
    return measure_cols >= 2


async def _build_answer(
    session: Session,
    llm: LLMClient,
    emb: EmbeddingClient,
    vs: VectorStore,
    dremio: DremioClient,
    question: str,
    trace: list[str],
    feedback: str,
) -> V3Result:
    """Decompose → per-sub single-question run → compose → answer. `feedback` (from Review) is
    threaded into decompose + each sub-run so a re-plan can correct the prior mistake."""
    model = llm._model

    # ── 0. Decompose (Intake-split) ───────────────────────────────────────────
    decompose_agent = build_decompose_agent(model)
    dec_prompt = question if not feedback else f"{question}\n\n[Re-plan context: {feedback}]"
    dec_run = await _run_agent(decompose_agent, dec_prompt)
    _trace(trace, dec_run.markdown)
    decomposed = dec_run.ok and dec_run.result.is_multi and len(dec_run.result.sub_questions) > 1

    if not decomposed:
        res, _state = await _run_with_retry(session, llm, emb, vs, dremio, question, trace, feedback=feedback)
        return res

    # multi-part: run every sub-question IN PARALLEL (they are independent), then compose. asyncio
    # gives each gather task its OWN copy of the context, so _SUB_ID.set() inside one sub does not
    # leak into another — every event a sub emits is tagged with its sub_id and the UI groups the
    # interleaved steps per sub-question. Announce the split up front so the UI can lay out columns.
    subs = dec_run.result.sub_questions
    await _emit("decomposed", {"sub_questions": [{"id": s.id, "question": s.question} for s in subs]})
    sub_pairs = list(await asyncio.gather(
        *(_run_sub(llm, emb, vs, dremio, sub, trace) for sub in subs)
    ))
    sub_results = [r for (_sid, r, _st) in sub_pairs]

    combined = await _compose(model, sub_results, question, trace)
    # Carry each sub's FULL render payload up: its own sql, rows, charts, answer — persistence saves
    # one query_result PER sub (each with its own charts), and the FE renders + reloads each sub. This
    # is why charts from a multi-part answer survive a reload. (Also feeds the final Review.)
    combined.sub_results = [
        {
            "id": sid,
            "question": r.question,
            "success": r.success,
            "error": r.error,
            "sql": r.sql,
            "row_count": r.row_count,
            "columns": list(r.rows[0].keys()) if r.rows else [],
            "rows": r.rows,                         # FULL rows (persisted), not a 10-row sample
            "charts": r.charts,
            "answer_markdown": r.answer_markdown,
        }
        for (sid, r, _st) in sub_pairs
    ]
    # ONE unified answer covering ALL parts. When the subs were merged, combined.rows already holds
    # everything; when they were NOT merged (different grains), combined.rows is only one sub — so
    # give the insight EVERY sub's own table as extra context, so the single answer still covers each
    # part (otherwise it would describe only the sub that became the combined table).
    if combined.success and combined.rows:
        parts = [
            f"\n\nPart — {s['question']} ({s['row_count']} rows, columns {s['columns']}):\n{(s['rows'] or [])[:20]}"
            for s in combined.sub_results if s.get("success") and s.get("rows")
        ]
        extra = ("\n\nThis question had SEVERAL parts. Write ONE answer that covers EVERY part below "
                 "(do not say a part's data is missing — each part's table is given):" + "".join(parts)) \
            if len(parts) > 1 else ""
        await _run_insight(model, combined, question, trace, extra_context=extra)

    # Charts LAST — now that the combined answer is written + streamed, generate each sub's charts
    # (deferred from the sub-runs) so the user saw the answer first. Each runs in the sub's context
    # so its chart_review + charts events are tagged with sub_id; sub_done carries the final charts.
    for sid, r, _st in sub_pairs:
        _SUB_ID.set(sid)
        if r.success and r.rows:
            await _run_chart(model, r, r.question, trace)
        await _emit("sub_done", {
            "sub_id": sid, "ok": bool(r.success), "row_count": r.row_count,
            "sql": r.sql, "rows": r.rows, "charts": r.charts, "answer_markdown": r.answer_markdown,
        })
    _SUB_ID.set(None)
    # refresh the persisted per-sub charts now that they exist
    for entry, (_sid, r, _st) in zip(combined.sub_results, sub_pairs):
        entry["charts"] = r.charts

    # follow-ups ONCE for the whole answer — grounded in a successful sub's schema (unused columns /
    # related tables). Subs skipped follow-ups (deferred), so a decomposed answer gets them here.
    first_ok = next(((r, st) for (_sid, r, st) in sub_pairs if r.success and r.rows), None)
    if first_ok is not None:
        _, st = first_ok
        with Session(engine) as fu_session:
            await _run_followups(fu_session, model, st, combined, question, trace)
    return combined


async def _run_sub(
    llm: LLMClient, emb: EmbeddingClient, vs: VectorStore,
    dremio: DremioClient, sub, trace: list[str],
) -> tuple[str, V3Result]:
    """Run ONE sub-question as its own isolated task: tag its events with sub_id (so the UI can group
    its steps + render THIS sub's own charts), emit sub_started/sub_done, and RE-RUN this sub (not the
    whole plan) if it fails — a sub failure is usually a flaky weak-model miss, and re-running only the
    failed sub avoids wasting work on the sibling subs that already succeeded. Returns (sub_id, result)."""
    _SUB_ID.set(sub.id)  # isolated: asyncio.gather gives this task its own context copy — every event
                         # this sub emits (result, charts, agent_started…) is auto-tagged with sub_id
    sub_trace: list[str] = [f"# Sub-question {sub.id}: {sub.question}"]
    await _emit("sub_started", {"sub_id": sub.id, "question": sub.question})
    res = V3Result(success=False, error="not run")
    state = PipelineState(question=sub.question)
    # each parallel sub gets its OWN DB session — a SQLModel Session is not safe to share across
    # concurrently-running coroutines (their queries would interleave on one connection).
    with Session(engine) as sub_session:
        for attempt in range(3):  # up to 3 tries for THIS sub only
            # DATA only — skip this sub's insight AND charts; charts run later (after the combined
            # answer is shown), so the user sees the final answer before the slower charts.
            res, state = await _run_with_retry(sub_session, llm, emb, vs, dremio, sub.question, sub_trace,
                                               feedback="", skip_insight=True, skip_charts=True)
            if res.success or res.needs_clarification:
                break
            _trace(sub_trace, f"## Sub retry\n- ⚠️ sub failed ({res.error}) → retrying this sub (attempt {attempt + 2})")
    res.question = sub.question
    # data is ready (no charts yet) — tell the FE the sub's rows so it can show the sub's table
    await _emit("sub_data_ready", {
        "sub_id": sub.id, "ok": bool(res.success), "row_count": res.row_count,
        "sql": res.sql, "rows": res.rows,
    })
    _trace(trace, "\n\n".join(sub_trace))  # fold this sub's trace into the run trace for the debug dump
    return sub.id, res, state


async def _run_with_retry(
    session: Session, llm: LLMClient, emb: EmbeddingClient, vs: VectorStore,
    dremio: DremioClient, question: str, trace: list[str], feedback: str = "",
    skip_insight: bool = False, skip_charts: bool = False,
) -> tuple[V3Result, PipelineState]:
    """Run the single-question pipeline; on a compile/validation failure (weak-model grounding
    variance often picks the wrong sibling entity), re-plan ONCE with fresh LLM calls. A different
    sampling usually lands a valid plan. Clarification requests are returned as-is (not retried).
    `skip_insight`/`skip_charts`: for a sub-question both are deferred — the ONE combined answer is
    written first, THEN the per-sub charts run, so the user sees the answer before the charts.
    Returns (result, state) — the state feeds the deferred chart + follow-up steps for a sub."""
    res, state = await _run_single_question(session, llm, emb, vs, dremio, question, trace, feedback,
                                            skip_insight, skip_charts)
    if res.success or res.needs_clarification:
        return res, state
    _trace(trace, f"## Re-plan\n- ⚠️ first attempt failed ({res.error}) → re-planning once")
    res2, state2 = await _run_single_question(session, llm, emb, vs, dremio, question, trace, feedback,
                                              skip_insight, skip_charts)
    return (res2, state2) if (res2.success or res2.needs_clarification) else (res, state)


async def _run_single_question(
    session: Session,
    llm: LLMClient,
    emb: EmbeddingClient,
    vs: VectorStore,
    dremio: DremioClient,
    question: str,
    trace: list[str],
    feedback: str = "",
    skip_insight: bool = False,
    skip_charts: bool = False,
) -> tuple[V3Result, PipelineState]:
    state = PipelineState(question=question)
    model = llm._model  # reuse the configured OpenAILike (same local weak model)
    fb_suffix = "" if not feedback else f"\n\n[Re-plan context from review: {feedback}]"

    # ── 1. Intake ─────────────────────────────────────────────────────────────
    intake_agent = build_intake_agent(model)
    intake_run = await _run_agent(intake_agent, question + fb_suffix)
    _trace(trace, intake_run.markdown)
    if not intake_run.ok:
        return _fail(trace, "intake parse failed: " + (intake_run.error or "")), state
    intake: IntakeOut = intake_run.result
    state.intent = intake.intent
    state.detected_terms = intake.detected_terms

    # dedicated Rank agent — the Intake model juggles many fields and often drops 'top N'/'nhất',
    # which would return ALL groups. A focused agent decides ranking + limit + direction reliably.
    rank_agent = build_rank_agent(model)
    rank_run = await _run_agent(rank_agent, question)
    if rank_run.ok:
        ranking = rank_run.result.is_ranking
        rank_limit = rank_run.result.limit
        rank_direction = rank_run.result.direction
    else:  # parse miss → fall back to Intake's own flags
        ranking, rank_limit, rank_direction = intake.ranking, intake.rank_limit, intake.rank_direction
    state.output_hints.ranking = ranking
    state.output_hints.limit = rank_limit
    state.output_hints.direction = rank_direction
    # a THRESHOLD question ('how many X have more than N Y') is a HAVING the flat SQL can't do — so we
    # GROUP BY the subject in SQL (per-X counts) and apply the threshold + count the survivors in the
    # pandas Transform. It therefore needs BOTH a per-X breakdown and a Transform.
    threshold = intake.threshold and intake.threshold_value is not None
    # ranking is done in pandas Transform (nlargest/nsmallest), not SQL — SQL returns all groups,
    # Transform ranks + trims. So a ranking question runs Transform.
    want_transform = intake.share or ranking or threshold or bool(intake.share_of_value)
    # a plain-total question (no per-X breakdown, no ranking) has NO dimensions and NO display
    # label — it's a single number. Ranking / threshold imply a per-entity breakdown, so they group.
    # A share-of-category groups by the category column (added below), so it also breaks down.
    wants_breakdown = intake.grouping or ranking or threshold or bool(intake.share_of_value)

    # ── 2. Retrieval (deterministic tool body — the v2 per-term fix, reused) ──
    retrieval = await retrieve_candidates(
        session, emb, vs, question, terms=intake.detected_terms or None
    )
    _trace(trace, _retrieval_md(retrieval))
    if not retrieval.entities:
        return _fail(trace, "no candidate entities retrieved"), state
    candidates_md = render_candidates_block(retrieval, session)
    # names→ids resolver, scoped to these candidates — a name outside them is rejected, not guessed
    resolver = NameResolver.from_retrieval(retrieval, session)

    # ── 2.5 Clarify — ask if ambiguous, else pick display columns ─────────────
    clarify_agent = build_clarify_agent(model)
    clarify_run = await _run_agent(clarify_agent, f"{candidates_md}\n\nQuestion: {question}")
    _trace(trace, clarify_run.markdown)
    display_column_ids: list[int] = []
    if clarify_run.ok:
        c = clarify_run.result
        # suppress a clarification when it's really about display columns, OR when the question uses
        # a defined glossary term (well-defined — the Filter agent applies its predicate). The weak
        # model over-asks about glossary terms; this code guard makes the suppression deterministic.
        spurious = (
            _is_display_clarification(c.clarifying_question)
            or _question_uses_glossary(session, question)
            or _clarification_names_physical_tables(session, c.clarifying_question, c.options)
        )
        if c.needs_clarification and c.clarifying_question and not spurious:
            res = V3Result(
                success=False, question=question, needs_clarification=True,
                clarifying_question=c.clarifying_question, clarify_options=c.options,
                trace_md="\n\n---\n\n".join(trace),
            )
            return res, state
        display_column_ids = [cid for ref in c.display_columns if (cid := resolver.column(ref))]

    # ── 3. Grain ──────────────────────────────────────────────────────────────
    grain_agent = build_grain_agent(model)
    grain_run = await _run_agent(grain_agent, f"{candidates_md}\n\nQuestion: {question}")
    _trace(trace, grain_run.markdown)
    if not grain_run.ok:
        return _fail(trace, "grain parse failed: " + (grain_run.error or "")), state
    grain: GrainOut = grain_run.result
    grain_id = resolver.entity(grain.grain_entity)
    if grain_id is None:
        return _fail(trace, f"grain table '{grain.grain_entity}' not in candidates"), state
    state.grain_entity_id = grain_id
    grain_entity = session.get(Entity, grain_id)
    state.grain = grain_entity.grain_description if grain_entity else "one row per record"
    state.entities = [
        EntityMatch(term="", entity_id=e.id, table_physical_path="", confidence=1.0)
        for e in retrieval.entities
    ]
    # targets = only entities the query actually touches (grain + metric/dim entities), grown
    # as Metric/Slice pick columns. Seeding ALL retrieved candidates makes step6 try to join
    # every sibling table and the validator allow-list to mismatch the real SQL.
    state.target_entity_ids = {grain_id}

    # ── 4. Metric ─────────────────────────────────────────────────────────────
    metric_agent = build_metric_agent(model)
    metric_run = await _run_agent(metric_agent, f"{candidates_md}\n\nQuestion: {question}")
    _trace(trace, metric_run.markdown)
    if not metric_run.ok:
        return _fail(trace, "metric parse failed: " + (metric_run.error or "")), state
    if not _apply_metrics(session, state, metric_run.result, resolver):
        return _fail(trace, "metric referenced a column outside the candidates"), state

    # ── 5. Slice (dimensions) — ONLY for a breakdown question ────────────────
    # A plain total (no breakdown) must have ZERO dimensions and ZERO display columns, or the
    # metric gets a spurious GROUP BY (COUNT DISTINCT id GROUP BY id → all-1s). Skip Slice + display
    # deterministically when the question wants no breakdown — the weak model can't override this.
    if wants_breakdown:
        ok = await _run_slice(session, model, state, candidates_md, question, trace, resolver)
        if not ok:
            return _fail(trace, "slice parse failed"), state
        # A RANKING is per-grain: 'top 5 workflows by node count' MUST group by workflow. The weak
        # slice model sometimes reads a ranking as a plain total and returns 0 dimensions — the SQL
        # then aggregates ALL rows into one number (the 613-bug). Deterministically ensure the grain
        # table's own id is a dimension whenever we rank, so the count is per-grain, not global.
        if ranking and not state.dimensions:
            _ensure_grain_dimension(session, state, trace)
        # Clarify's display columns → SELECT (label for each group + the grain id as merge key). ONLY
        # when there ARE dimensions: display columns are labels FOR a grouping. If Slice chose ZERO
        # dimensions (a scalar total / single percentage), adding them would force a spurious GROUP BY
        # (label, node_id → one row per node = the 625-row explosion).
        if state.dimensions:
            _apply_display_columns(session, state, display_column_ids)
        else:
            _trace(trace, "## Display\n- skipped display columns (Slice chose 0 dimensions — scalar total)")
    else:
        _trace(trace, "## Slice\n- skipped (plain total — no breakdown, no dimensions)")

    # SHARE-OF-CATEGORY ('what % of rows are VALUE'): group by the value's category column (get counts
    # for ALL values incl. the target), so the Transform can compute target/total*100. The VALUE must
    # NOT become a WHERE filter — that removes the denominator. Find the column deterministically by the
    # value, add it as a dimension, and remember it so Filter skips it.
    share_cat_col_id = None
    if intake.share_of_value:
        share_cat_col_id = _find_category_column(session, state, intake.share_of_value)
        if share_cat_col_id is not None:
            # This is a clean 'SELECT category, COUNT(...) GROUP BY category' — REPLACE any dims the
            # earlier steps set (grain-id/label/display) with ONLY the category column. Otherwise the
            # grain's own id+label stay in GROUP BY → one row per node (count=1) and the back-edge then
            # drops the category too. The category has few values, so it is never 'over-grouped'.
            cat_entity = session.get(EntityColumn, share_cat_col_id).entity_id
            state.dimensions = [DimensionSpec(
                entity_id=cat_entity, id_column_id=share_cat_col_id, label_column_id=None)]
            state.group_by_column_ids = [share_cat_col_id]
            state.select_column_ids = [share_cat_col_id]
            state.target_entity_ids.add(cat_entity)
            _trace(trace, f"## Share-of-category\n- group by the value's category column ONLY instead of "
                         f"filtering '{intake.share_of_value}' (keeps the denominator)")

    # ── 6. Filter (WHERE + time) ──────────────────────────────────────────────
    await _run_filter(session, model, state, candidates_md, question, trace, resolver)
    # drop any filter the Filter agent put on the share category column — it must stay a dimension,
    # not a WHERE (else the total denominator is lost).
    if share_cat_col_id is not None:
        state.filters = [f for f in state.filters if f.column_id != share_cat_col_id]

    # ── 7. Compile + 8. Execute (deterministic v2: joins + AST + validate + run) ──
    # a share-of-category groups by a low-cardinality category on the grain table — a count of 1 per
    # value is NOT over-grouping, so skip the grain back-edge (it would wrongly drop the category).
    result, backedge = await _compile_execute_with_grain_check(
        session, model, dremio, state, candidates_md, question, trace, resolver,
        skip_backedge=(share_cat_col_id is not None)
    )
    result.grain_backedge_fired = backedge
    result.assumptions = state.assumptions
    if not result.success:
        result.trace_md = "\n\n---\n\n".join(trace)
        return result, state

    # ── 9. Transform (% / ratio / cumulative / ranking / threshold) — the Transform AGENT writes it ──
    if want_transform and result.rows:
        # the per-group measure column is KNOWN — the Metric agent's output alias (a real df column).
        measure = state.metrics[0].alias if state.metrics else None
        col_ref = f"'{measure}'" if measure else "'<the measure column from df>'"
        hint = ""
        force = ranking or threshold
        if threshold:
            op, val = intake.threshold_op, intake.threshold_value
            if intake.threshold_count:
                # 'how many X have >N Y' → keep the passing groups, then COUNT them → one number.
                hint = (
                    f"\n\nThreshold COUNT question: df has one row PER group with its count in column "
                    f"{col_ref}. Write code (needs_code=true) that returns HOW MANY groups pass — "
                    f"result = pd.DataFrame({{'group_count': [int((df[{col_ref}] {op} {val}).sum())]}}). "
                    f"Use EXACTLY that column; do not invent one."
                )
            else:
                # 'list the X that have >N Y' → KEEP the passing rows (the list of groups), don't count.
                hint = (
                    f"\n\nThreshold LIST question: df has one row PER group with its count in column "
                    f"{col_ref}. Write code (needs_code=true) that KEEPS only the rows where that count "
                    f"{op} {val}, keeping ALL columns — result = df[df[{col_ref}] {op} {val}]. Do NOT "
                    f"count or aggregate; just filter. Use EXACTLY that column; do not invent one."
                )
        elif intake.share_of_value and share_cat_col_id is not None:
            # SHARE-OF-CATEGORY: df has one row per category value with its count in col_ref. Compute
            # the target value's share of the total → one number. Category column name comes from df.
            cat_col = session.get(EntityColumn, share_cat_col_id)
            cat_name = cat_col.physical_name if cat_col else None
            val = intake.share_of_value.strip().strip("'\"")
            force = True
            hint = (
                f"\n\nShare-of-category question: df has one row PER value of column '{cat_name}' with "
                f"its count in {col_ref}. Compute what % the value '{val}' is of the TOTAL — write code "
                f"(needs_code=true): total = df[{col_ref}].sum(); target = df[df['{cat_name}'] == '{val}']"
                f"[{col_ref}].sum(); result = pd.DataFrame({{'{cat_name}': ['{val}'], 'count': [int(target)], "
                f"'pct': [round(target / total * 100, 2)]}}). Use EXACTLY those column names."
            )
        elif intake.share:
            # PER-GROUP SHARE ('mỗi loại chiếm bao nhiêu %'): add a pct column = each row's measure as a
            # % of the total. FORCED + fully specified so it never gets skipped (the non-determinism
            # where one run computed % and another said 'no denominator').
            force = True
            hint = (
                f"\n\nPercentage question: add a 'pct' column = each row's {col_ref} as a % of the TOTAL "
                f"— write code (needs_code=true): result = df.assign(pct=(df[{col_ref}] / "
                f"df[{col_ref}].sum() * 100).round(2)). Keep all original columns. Use EXACTLY that "
                f"column; do not invent one. Do not return needs_code=false."
            )
        elif ranking:
            n = rank_limit or 1
            fn = "nsmallest" if rank_direction == "asc" else "nlargest"
            hint = (
                f"\n\nThis question is a RANKING: you MUST write code (needs_code=true) to keep the "
                f"top {n} rows by the measure column — result = df.{fn}({n}, {col_ref}). "
                f"**Use EXACTLY that column name (a real df column); do NOT translate or invent one.** "
                f"Direction: {rank_direction}. Do not return needs_code=false."
            )
        await _run_transform(model, result, question, trace, hint, force=force)

    # ── 10. Insight (narrative, cited only) ───────────────────────────────────
    # A sub-question SKIPS its own narrative answer — the ONE unified answer is written once after all
    # subs finish (in _build_answer). A sub still produces its own CHARTS below.
    if not skip_insight:
        await _run_insight(model, result, question, trace)

    # emit the result table NOW (before chart vision review) so the FE has data to render the
    # proposed chart into the DOM — the vision step needs that rendered chart to screenshot.
    await _emit("result", {
        "sql": result.sql, "rows": result.rows, "row_count": result.row_count,
        "assumptions": result.assumptions,
    })

    # ── 11. Chart (pick + code-guard + text review + in-loop VISION review) ───
    # For a sub-question, charts are DEFERRED: they run in _build_answer AFTER the combined answer is
    # written + emitted, so the user sees the final answer BEFORE the (slower) charts appear. The
    # PipelineState is stashed on the result so the deferred chart run can reuse it.
    if not skip_charts:
        await _run_chart(model, result, question, trace)
        # ── 12. Follow-up questions (grounded in unused schema, same language) ─
        await _run_followups(session, model, state, result, question, trace)

    result.trace_md = "\n\n---\n\n".join(trace)
    return result, state


# ── slice + back-edge ────────────────────────────────────────────────────────

async def _run_slice(session, model, state, candidates_md, question, trace, resolver, *, flag: str = "") -> bool:
    slice_agent = build_slice_agent(model)
    grain_table = resolver.entity_name_by_id.get(state.grain_entity_id, "?")
    hint = ""
    if flag:
        hint = (
            f"\n\nIMPORTANT: a previous attempt {flag}. Choose ONLY the grain table's "
            f"id + label columns as dimensions. Do NOT add a dimension from any table whose "
            f"rows are being counted — that over-groups and makes every count 1."
        )
    slice_run = await _run_agent(slice_agent,
        f"{candidates_md}\n\nGrain table: {grain_table}\nQuestion: {question}{hint}"
    )
    _trace(trace, slice_run.markdown)
    if not slice_run.ok:
        return False
    _apply_dimensions(session, state, slice_run.result, resolver)
    return True


async def _run_filter(session, model, state, candidates_md, question, trace, resolver) -> None:
    """Filter agent: WHERE + time. Reuses v2's grounding guardrail (drop ungrounded id filters)."""
    filter_agent = build_filter_agent(model)
    filter_run = await _run_agent(filter_agent, f"{candidates_md}\n\nQuestion: {question}")
    _trace(trace, filter_run.markdown)
    if not filter_run.ok:
        return  # filters are optional; a parse miss just means no filters
    out: FilterOut = filter_run.result
    q_lower = question.lower()
    for f in out.filters:
        cid = resolver.column(f.column)
        col = session.get(EntityColumn, cid) if cid else None
        if col is None:
            continue  # a filter on an unresolved column is dropped, not guessed
        # v2 guardrail: drop an id/key filter whose value the user never named
        is_id = col.role == ColumnRole.KEY
        named = bool(f.value) and f.value.strip().lower() in q_lower
        if is_id and not named:
            state.add_assumption(
                f"Dropped filter on {col.display_name}: value {f.value!r} not named in the question."
            )
            continue
        state.filters.append(FilterSpec(column_id=col.id, operator=f.operator.strip(), value=f.value))
        state.target_entity_ids.add(col.entity_id)
    if out.time and out.time.time_column and (out.time.start or out.time.end):
        cid = resolver.column(out.time.time_column)
        col = session.get(EntityColumn, cid) if cid else None
        if col is not None:
            state.time = TimeSpec(
                column_id=col.id, start=out.time.start, end=out.time.end,
                tz="Asia/Ho_Chi_Minh", granularity=None,
            )
            state.target_entity_ids.add(col.entity_id)

    # glossary terms → BusinessRule (the vetted sql_expressions are AND-injected into WHERE by
    # templates). A term also scopes a specific entity, so pull its related entities into targets so
    # that table is in the FROM/JOIN for the predicate. We take the phrases the Filter agent flagged
    # AND any glossary term literally present in the question — so a missed flag (weak-model variance)
    # can't drop the predicate.
    _apply_glossary_terms(session, state, out.glossary_terms, question, trace)


def _apply_glossary_terms(session, state, phrases: list[str], question: str, trace: list[str]) -> None:
    from src.database.models import BusinessGlossaryTerm

    # deterministic backstop: add any glossary term whose name/synonym literally appears in the
    # question, even if the Filter agent didn't flag it.
    ql = question.lower()
    phrases = list(phrases or [])
    for t in session.exec(select(BusinessGlossaryTerm)).all():
        for name in (t.term, *(t.synonyms or [])):
            if name and name.lower() in ql and t.term not in phrases:
                phrases.append(t.term)

    if not phrases:
        return
    terms = session.exec(select(BusinessGlossaryTerm)).all()
    applied = []
    for phrase in phrases:
        key = phrase.strip().lower()
        match = None
        for t in terms:
            names = [t.term.lower(), *[sn.lower() for sn in (t.synonyms or [])]]
            if any(key in n or n in key for n in names if n):
                match = t
                break
        if match is None or not match.sql_expressions:
            continue
        entity_id = match.related_entity_ids[0] if match.related_entity_ids else None
        # a term can carry MULTIPLE predicates — add one BusinessRule per expression; templates
        # AND them together in the WHERE clause.
        for expr in match.sql_expressions:
            if not expr or not expr.strip():
                continue
            state.business_rules.append(BusinessRule(
                term=match.term, glossary_id=match.id, applies_to_entity_id=entity_id,
                filter_sql=expr, verified=True,
            ))
        # ensure the term's table is in the query so its predicates have something to filter
        for eid in (match.related_entity_ids or []):
            state.target_entity_ids.add(eid)
        applied.append(match.term)
    if applied:
        _trace(trace, f"## Glossary\n- applied: {applied} (predicates AND-injected into WHERE)")


async def _run_transform(model, result: V3Result, question: str, trace: list[str],
                         hint: str = "", force: bool = False) -> None:
    """Transform agent: WRITES pandas code (over `df`) to add derived columns or rank/trim rows
    (% / rank / cumulative / top-N). `hint` carries ranking specifics; `force`=True means the code
    is REQUIRED (ranking) — retry once if the agent skips it, so ranking is never dropped."""
    transform_agent = build_transform_agent(model)
    cols = list(result.rows[0].keys()) if result.rows else []
    prompt = (
        f"Question: {question}\n\n"
        f"df columns: {cols}\nfirst rows: {result.rows[:5]}\nrow count: {result.row_count}{hint}"
    )
    t_run = await _run_agent(transform_agent, prompt)
    _trace(trace, t_run.markdown)
    got_code = t_run.ok and t_run.result.needs_code and t_run.result.code.strip()
    if not got_code and force:
        # ranking is mandatory — push once more, harder.
        t_run = await _run_agent(transform_agent,
            prompt + "\n\nYou MUST return needs_code=true with the ranking code. It is required.")
        _trace(trace, t_run.markdown)
        got_code = t_run.ok and t_run.result.needs_code and t_run.result.code.strip()
    if not got_code:
        return
    new_rows, err = run_pandas_code(t_run.result.code, {"df": pd.DataFrame(result.rows)})
    if err:
        _trace(trace, f"## Transform\n- ❌ {err}\n```python\n{t_run.result.code}\n```")
        return
    result.rows = new_rows
    result.row_count = len(new_rows)
    result.transform_ops.append(t_run.result.explanation or "pandas transform")
    _trace(trace, 
        f"## Transform\n- ✅ {t_run.result.explanation}\n```python\n{t_run.result.code}\n```"
    )


async def _run_followups(session, model, state, result: V3Result, question: str, trace: list[str]) -> None:
    """Follow-ups agent: 2-3 next questions grounded in the UNUSED schema (columns/related tables/
    glossary the query didn't touch), in the user's language. Emits a `follow_ups` event."""
    from src.pipeline_v3.agents import build_followups_agent

    prompt = _render_unused_schema(session, state, question)
    fu_agent = build_followups_agent(model)
    fu_run = await _run_agent(fu_agent, prompt)
    if fu_run.ok and fu_run.result.questions:
        result.follow_up_questions = fu_run.result.questions[:3]
        await _emit("follow_ups", {"follow_up_questions": result.follow_up_questions})
        _trace(trace, f"## Follow-ups\n- {result.follow_up_questions}")


def _render_unused_schema(session, state, question: str) -> str:
    """Show the follow-ups agent what data EXISTS but wasn't used — so its suggestions are grounded:
    unused columns on the current tables, related tables, and unused glossary terms."""
    from src.database.models import BusinessGlossaryTerm, Entity, EntityColumn, EntityRelationship

    lines = [f"Original question (write suggestions in THIS language): {question}", ""]
    used_cols = set(state.select_column_ids) | set(state.group_by_column_ids)
    used_cols |= {f.column_id for f in state.filters}
    for m in state.metrics:
        if m.expr_column_id:
            used_cols.add(m.expr_column_id)

    lines.append("Columns on the current tables ([used] ones are already in this query):")
    for eid in state.target_entity_ids:
        ent = session.get(Entity, eid)
        if ent is None:
            continue
        cols = session.exec(select(EntityColumn).where(
            EntityColumn.entity_id == eid, EntityColumn.is_exposed == True,  # noqa: E712
            EntityColumn.is_deprecated == False)).all()  # noqa: E712
        for c in cols:
            mark = " [used]" if c.id in used_cols else ""
            role = c.role.value if c.role else "?"
            lines.append(f"  [{ent.display_name}] {c.display_name} (role={role}){mark}")

    # related tables reachable from the ones in play
    rels = session.exec(select(EntityRelationship).where(
        (EntityRelationship.from_entity_id.in_(state.target_entity_ids))
        | (EntityRelationship.to_entity_id.in_(state.target_entity_ids)))).all()
    related_ids = set()
    for r in rels:
        for eid in (r.from_entity_id, r.to_entity_id):
            if eid not in state.target_entity_ids:
                related_ids.add(eid)
    if related_ids:
        lines.append("\nRelated tables reachable from the current ones (for deeper questions):")
        for e in session.exec(select(Entity).where(Entity.id.in_(related_ids))).all():
            lines.append(f"  {e.display_name}: {e.description or e.grain_description or ''}")

    # unused glossary concepts
    used_terms = {r.term for r in state.business_rules}
    unused = [g for g in session.exec(select(BusinessGlossaryTerm)).all()
              if g.term not in used_terms and g.sql_expressions]
    if unused:
        lines.append("\nBusiness concepts available (not used here):")
        for g in unused:
            lines.append(f"  {g.term}: {(g.definition_text or '')[:100]}")

    lines.append("\nSuggest 2-3 follow-up questions grounded ONLY in the schema above.")
    return "\n".join(lines)


def _strip_md_fence(text: str) -> str:
    """Drop a ```markdown … ``` (or ``` … ```) code-fence wrapper the Worker sometimes puts around
    the whole answer, so the markdown renders as markdown instead of a literal code block."""
    t = text.strip()
    if t.startswith("```"):
        first_nl = t.find("\n")
        if first_nl != -1:
            t = t[first_nl + 1:]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


async def _run_insight(model, result: V3Result, question: str, trace: list[str],
                       extra_context: str = "") -> None:
    """Insight agent: narrative + chart, citing only numbers present in the result.

    The Insight Worker's markdown IS the answer, so we stream its content deltas straight to the
    UI as `answer_delta` events (the answer types out live), while the Parser still extracts the
    chart spec + cited numbers from that same markdown. `extra_context` carries extra data the answer
    must cover (e.g. every sub-question's own table when a decomposed answer wasn't merged into one)."""
    insight_agent = build_insight_agent(model)
    rows_preview = result.rows[:20]
    prompt = f"Question: {question}\n\nResult rows:\n{rows_preview}{extra_context}"

    base_sink = _SINK.get()

    async def answer_sink(etype: str, payload: dict) -> None:
        # re-tag the insight Worker's content deltas as answer_delta so the UI streams the answer;
        # pass tool/agent events through unchanged.
        if base_sink is None:
            return
        if etype == "agent_delta":
            await base_sink("answer_delta", {"delta": payload.get("delta", "")})
        else:
            await base_sink(etype, payload)

    await _emit("agent_started", {"agent": "insight", "label": _STEP_LABELS["insight"]})
    i_run = await insight_agent.run(prompt, on_event=answer_sink)
    await _emit("agent_done", {"agent": "insight", "ok": i_run.ok})
    _trace(trace, i_run.markdown)
    if not i_run.ok:
        result.answer_markdown = "(insight unavailable)"
        return
    out = i_run.result
    # cite guard: keep only cited numbers that actually appear in the result — include every sub's
    # rows too, since a combined answer legitimately quotes numbers from all sub-question tables.
    present = _numbers_in_rows(result.rows)
    for s in (result.sub_results or []):
        present |= _numbers_in_rows(s.get("rows") or [])
    hallucinated = [n for n in out.cited_numbers if _norm_num(n) and _norm_num(n) not in present]
    # The Worker's markdown IS the answer and is the SAME text that streamed to the UI (clean
    # markdown). Use it verbatim so the finished/reloaded answer renders exactly like the stream —
    # the Parser's answer_markdown is a re-serialized copy that can lose formatting. Fall back to
    # the parser only if the Worker produced nothing.
    result.answer_markdown = _strip_md_fence(i_run.markdown) or out.answer_markdown
    note = "" if not hallucinated else f"  ⚠️ uncited numbers flagged: {hallucinated}"
    _trace(trace, f"## Insight\n- answer written{note}")


async def _build_one_chart(model, item, sql_rows: list[dict], question: str, trace: list[str]) -> dict | None:
    """Produce ONE chart. The CHART AGENT owns every field/type/transform choice — its x/y are used
    verbatim (validated only for existence). A Field agent REVIEWS the chart against the real data and
    only gives feedback; on 'not suitable' we loop back to the chart agent (chart_fix) to REVISE it —
    reviewers never edit the chart themselves. The deterministic guard is a pure anti-empty backstop
    for the final attempt only, so a chart never persists field-less."""
    from src.pipeline_v3.agents import build_chart_fix_agent, build_field_agent

    def run_transform(code: str, base: list[dict]) -> list[dict]:
        if not code:
            return base
        rows, err = run_pandas_code(code, {"df": pd.DataFrame(base)})
        if err:
            _trace(trace, f"## Chart transform\n- ❌ {err}\n```python\n{code}\n```")
            return base
        return rows

    field_agent = build_field_agent(model)
    fix_agent = build_chart_fix_agent(model)

    ctype = (item.chart_type or "bar").lower()
    x = item.chart_x
    ys = list(item.chart_y)
    transform_code = (item.transform_code or "").strip()

    for attempt in range(3):  # initial proposal + 2 chart-agent revisions
        if ctype == "stat":  # unsupported — the chart agent shouldn't propose it, but guard anyway
            _trace(trace, "## Chart field\n- ⚠️ dropped stat (unsupported chart type)")
            return None
        chart_rows = run_transform(transform_code, sql_rows)
        cols = list(chart_rows[0].keys()) if chart_rows else []

        # Field agent REVIEWS the chart-agent's fields against the real data — it only judges.
        f_run = await _run_agent(field_agent,
            f"Chart type: {ctype}\nProposed x: {x}\nProposed y: {ys}\n"
            f"Available columns: {cols}\nSample rows: {chart_rows[:6]}\nQuestion: {question}")
        fields_exist = (x in cols) and bool(ys) and all(c in cols for c in ys)
        approved = fields_exist and (not f_run.ok or f_run.result.suitable)
        if approved:
            return {
                "type": ctype, "x": x, "y": ys, "value_field": None,
                "title": item.title or question, "recommended": bool(item.recommended),
                "rows": chart_rows, "transform_code": transform_code,
            }

        if attempt == 2:
            break
        feedback = (f_run.result.feedback if (f_run.ok and f_run.result.feedback)
                    else f"x={x} / y={ys} are not valid columns of {cols}")
        _trace(trace, f"## Chart review\n- ⚠️ ({ctype}) {feedback} → chart agent revising")
        # loop back to the CHART AGENT to revise — the ONLY thing allowed to change the chart.
        fix_run = await _run_agent(fix_agent,
            f"Question: {question}\n\nCurrent chart: type={ctype}, x={x}, y={ys}, "
            f"title={item.title or question}, transform_code={transform_code!r}\n"
            f"Available columns (SQL result): {list(sql_rows[0].keys()) if sql_rows else []}\n"
            f"Sample rows: {sql_rows[:5]}\n\nReviewer rejected it: {feedback}\n"
            f"Return ONE corrected chart.")
        if fix_run.ok and fix_run.result.charts:
            fixed = fix_run.result.charts[0]
            # KEEP the chart agent's original TYPE — a review fixes fields/data, never bar↔pie↔line
            # (that is the proposal-time diversity choice). Only x/y/transform may change here.
            x = fixed.chart_x
            ys = list(fixed.chart_y)
            transform_code = (fixed.transform_code or "").strip()

    # Reviewed 3 times and still not approved → DROP this chart. We do NOT force-guess fields here:
    # a chart the reviewer never accepted is more likely wrong than useful, and persisting a guessed
    # version is exactly what desyncs streaming vs reload. Keep it ONLY if the last revision's fields
    # are genuinely valid (a real pass the loop's final iteration didn't get to re-check).
    chart_rows = run_transform(transform_code, sql_rows)
    cols = list(chart_rows[0].keys()) if chart_rows else []
    if x in cols and ys and all(c in cols for c in ys):
        return {
            "type": ctype, "x": x, "y": ys, "value_field": None,
            "title": item.title or question, "recommended": bool(item.recommended),
            "rows": chart_rows, "transform_code": transform_code,
        }
    _trace(trace, f"## Chart review\n- ⚠️ dropped {ctype} after 3 failed reviews (x={x}, y={ys})")
    return None


async def _run_chart(model, result: V3Result, question: str, trace: list[str]) -> None:
    """Chart agent proposes 1-3 charts from the REAL columns; a code guard fixes invalid fields so
    none render empty; then each chart is VISION-reviewed (FE renders it, posts the image, a vision
    model re-picks it if wrong). Result carries the full list."""
    if not result.rows:
        return
    columns = list(result.rows[0].keys())
    sample = result.rows[:5]
    chart_agent = build_chart_agent(model)

    c_run = await _run_agent(chart_agent,
        f"Question: {question}\n\nResult columns (use EXACT names): {columns}\nSample rows: {sample}")
    items = c_run.result.charts if (c_run.ok and c_run.result.charts) else []
    charts: list[dict] = []
    seen: set[tuple] = set()  # dedup — the weak model sometimes proposes duplicate charts
    for it in items[:4]:
        # the agent proposes VISUAL charts only — ignore any 'table' it returns (table is code-added).
        if (it.chart_type or "").lower() == "table":
            continue
        chart = await _build_one_chart(model, it, result.rows, question, trace)
        if chart is None:
            continue
        key = (chart["type"], chart.get("x"), tuple(chart.get("y") or []))
        if key in seen:  # same type + same fields → duplicate, skip
            continue
        seen.add(key)
        charts.append(chart)
        if len(charts) >= 3:
            break
    if not charts:  # nothing usable → one guarded default bar on the raw rows
        x, ys = _guard_chart_fields(None, [], columns)
        charts = [{"type": "bar", "x": x, "y": ys, "title": question, "recommended": True, "rows": result.rows}]
    if not any(c["recommended"] for c in charts):
        charts[0]["recommended"] = True

    # VISION review each VISUAL chart in-loop (FE renders + posts image per chart).
    reviewed = [await _vision_review_chart(model, c, columns, question, trace) for c in charts]

    # ALWAYS append a data table of the raw SQL result — never transformed, never reviewed.
    reviewed.append({
        "type": "table", "x": None, "y": columns, "title": "Bảng dữ liệu",
        "recommended": False, "rows": result.rows,
    })
    result.charts = reviewed
    _trace(trace, "## Charts\n" + "\n".join(f"- {c['type']}" for c in reviewed))


async def _vision_review_chart(model, chart: dict, columns, question, trace) -> dict:
    """Emit a chart_review request for ONE chart, wait for its FE-rendered image via the queue, run
    vision review, re-pick once if rejected. Falls back to the given chart on timeout / no sink."""
    from src.pipeline_v3.chart_image_queue import chart_image_queue

    sink = _SINK.get()
    if sink is None:  # no streaming client (test/shadow runner) → skip vision review
        return chart

    review_id = chart_image_queue.register()
    await _emit("chart_review", {"review_id": review_id, "chart": chart, "columns": columns})
    image_png = await chart_image_queue.wait(review_id, timeout=12.0)
    if image_png is None:
        return chart

    from src.pipeline_v3.chart_vision import review_chart_image
    res = await review_chart_image(model, question, image_png, list(columns), chart)
    if res.get("satisfied"):
        return chart
    return res.get("chart") or chart


def _guard_chart_fields(x: str | None, ys: list[str], columns: list[str]) -> tuple[str | None, list[str]]:
    """Code fallback so a chart never renders empty: keep x/y only if they are real columns; else
    auto-pick — first non-numeric column as x (the label), the numeric columns as y (the measures)."""
    valid_y = [c for c in ys if c in columns]
    valid_x = x if x in columns else None
    if valid_x and valid_y:
        return valid_x, valid_y
    # auto-detect from the columns (needs a sample to tell numeric from label — infer by name/order)
    if valid_x is None:
        valid_x = next((c for c in columns if not c.endswith("_id") and "count" not in c.lower()
                        and "pct" not in c.lower() and "total" not in c.lower()), columns[0] if columns else None)
    if not valid_y:
        valid_y = [c for c in columns if c != valid_x and (
            "count" in c.lower() or "pct" in c.lower() or "total" in c.lower() or "sum" in c.lower()
            or "avg" in c.lower())]
        if not valid_y:  # last resort: any column that isn't x or an id
            valid_y = [c for c in columns if c != valid_x and not c.endswith("_id")][:1]
    return valid_x, valid_y


def _numbers_in_rows(rows: list[dict]) -> set[str]:
    out: set[str] = set()
    for r in rows:
        for v in r.values():
            n = _norm_num(v)
            if n:
                out.add(n)
    return out


def _norm_num(v) -> str | None:
    try:
        f = float(str(v).replace("%", "").replace(",", "").strip())
    except (ValueError, TypeError):
        return None
    return str(int(f)) if f == int(f) else str(round(f, 2))


def _richest_sub(ok: list[V3Result]) -> V3Result:
    best = max(ok, key=lambda r: (len(r.rows[0].keys()) if r.rows else 0, r.row_count))
    return V3Result(success=True, rows=best.rows, row_count=best.row_count)


async def _compose(model, sub_results: list[V3Result], question: str, trace: list[str]) -> V3Result:
    """Combine the sub-results. Each sub already shows its own result + charts, so a merge is OPTIONAL.
    The COMPOSE AGENT decides whether to merge and on WHICH key (not hardcoded heuristics); the CODE
    then performs the merge deterministically so a weak model never writes join code that KeyErrors.
    When the agent says not to merge (different grains), the richest sub becomes the combined table and
    each sub's own block carries the rest. The unified answer is written afterwards by one Insight pass."""
    ok = [r for r in sub_results if r.success and r.rows]
    if not ok:
        return V3Result(success=False, error="no sub-question produced rows")
    if len(ok) < 2:
        return V3Result(success=True, rows=ok[0].rows, row_count=ok[0].row_count)

    # ask the compose agent: should we merge, and on which shared key?
    schema_desc = "\n".join(
        f"Sub {i} columns: {list(r.rows[0].keys())}; sample rows: {r.rows[:3]}"
        for i, r in enumerate(ok)
    )
    compose_agent = build_compose_agent(model)
    c_run = await _run_agent(compose_agent, f"Original question: {question}\n\n{schema_desc}")
    _trace(trace, c_run.markdown)

    decision = c_run.result if c_run.ok else None
    colsets = [set(r.rows[0].keys()) for r in ok]
    key = decision.merge_key if decision else None
    # only merge when the agent said so AND its key really exists in EVERY sub (guard against a
    # hallucinated column name — a bad key is exactly what caused the old KeyError).
    if decision and decision.should_merge and key and all(key in cs for cs in colsets):
        how = decision.how if decision.how in ("outer", "inner") else "outer"
        try:
            merged_df = pd.DataFrame(ok[0].rows)
            for r in ok[1:]:
                merged_df = merged_df.merge(pd.DataFrame(r.rows), on=key, how=how, suffixes=("", "_dup"))
            merged_df = merged_df.loc[:, ~merged_df.columns.str.endswith("_dup")]
            merged = merged_df.to_dict("records")
            _trace(trace, f"## Compose\n- ✅ merged {len(ok)} subs on '{key}' ({how}) → {len(merged)} rows"
                         f" — {decision.reason}")
            return V3Result(success=True, rows=merged, row_count=len(merged))
        except Exception as e:  # noqa: BLE001 — a merge failure must not lose the answer
            _trace(trace, f"## Compose\n- ⚠️ merge on '{key}' failed ({e}); using richest sub")
            return _richest_sub(ok)

    why = (decision.reason if decision else "no decision") if not (decision and decision.should_merge) \
        else f"key '{key}' not in all subs"
    _trace(trace, f"## Compose\n- ⏭️ not merging ({why}); using richest sub as combined table")
    return _richest_sub(ok)


async def _compile_execute_with_grain_check(
    session, model, dremio, state, candidates_md, question, trace, resolver, skip_backedge: bool = False
) -> tuple[V3Result, bool]:
    backedge_fired = False
    for attempt in range(2):  # original + one grain back-edge re-plan
        # deterministic join planning (v2, no LLM) then compile+validate+execute (v2)
        run_step6(session, state)
        gen = run_step8(session, dremio, state)
        if not gen.success:
            _trace(trace, f"## Compile/Execute\n- ❌ {gen.error}")
            return V3Result(success=False, error=gen.error), backedge_fired

        rows = gen.execution.rows if gen.execution else []
        row_count = gen.execution.row_count if gen.execution else 0
        flag = None if skip_backedge else _grain_check(state, rows, row_count)
        _trace(trace, _execute_md(gen.sql, rows, row_count, flag))

        if flag is None or attempt == 1:
            return (
                V3Result(success=True, sql=gen.sql, rows=rows, row_count=row_count),
                backedge_fired,
            )

        # back-edge: clear the plan slots, re-run Slice with the flag, then HARD-enforce
        # grain-only dimensions in code. Re-prompting alone can't be trusted for a weak model
        # that just over-grouped — so after the re-slice we deterministically drop any dimension
        # whose entity is not the grain. Belt (re-prompt) + suspenders (code filter).
        backedge_fired = True
        state.dimensions = []
        state.group_by_column_ids = []
        state.select_column_ids = []
        state.join_plan = None
        _trace(trace, f"## Grain back-edge\n- ⚠️ {flag} → re-planning dimensions (grain-only enforced)")
        await _run_slice(session, model, state, candidates_md, question, trace, resolver, flag=flag)
        _force_grain_only_dims(session, state, trace)

    return V3Result(success=False, error="grain check failed after re-plan"), backedge_fired


def _ensure_grain_dimension(session: Session, state: PipelineState, trace: list[str]) -> None:
    """Backstop for a RANKING with no dimensions: synthesize the grain table's own id (+ best label)
    as the single GROUP BY dimension, so the measure is counted PER grain row, not globally. Without
    this a 'top 5 workflows by node count' aggregates every node into one number."""
    grain = state.grain_entity_id
    gid = _grain_id_column(session, grain)
    if gid is None:
        _trace(trace, "## Slice\n- ⚠️ ranking with no dimension and no grain id column — cannot group")
        return
    label = _best_label_column(session, grain)
    state.dimensions = [DimensionSpec(entity_id=grain, id_column_id=gid, label_column_id=label)]
    state.group_by_column_ids = [gid]
    state.select_column_ids = [label] if label is not None else []
    state.target_entity_ids = {grain} | {
        session.get(EntityColumn, m.expr_column_id).entity_id
        for m in state.metrics if m.expr_column_id is not None
    }
    _trace(trace, "## Slice\n- ⚠️ ranking had 0 dimensions → forced grain id as GROUP BY (per-grain count)")


def _force_grain_only_dims(session: Session, state: PipelineState, trace: list[str]) -> None:
    """Deterministic recovery: keep only dimensions on the grain entity; drop the rest.
    Rebuilds group_by/select from the surviving dims. Guarantees the re-plan can't over-group
    again even if the weak model repeats its mistake."""
    grain = state.grain_entity_id
    kept = [d for d in state.dimensions if d.entity_id == grain]
    dropped = [d for d in state.dimensions if d.entity_id != grain]
    if not kept:
        # nothing on the grain survived — synthesize the grain's own id + best label
        gid = _grain_id_column(session, grain)
        if gid is not None:
            kept = [DimensionSpec(entity_id=grain, id_column_id=gid, label_column_id=_best_label_column(session, grain))]
    state.dimensions = kept
    state.group_by_column_ids = [d.id_column_id for d in kept]
    # SELECT each dimension's DISPLAY column: its label if it has one, otherwise the id column itself
    # (a category dimension like connection_type IS its own display value — without this it would be
    # grouped by but never selected, so the result has no category column and the chart has no x-axis).
    state.select_column_ids = [d.label_column_id or d.id_column_id for d in kept]
    # the bad plan's target set may still name entities the grain-only plan never touches
    # (e.g. a sibling the join planner would then try to reach). Reset targets to grain +
    # surviving dim + metric entities so step6 only joins what the clean plan needs.
    state.target_entity_ids = {grain} | {d.entity_id for d in kept}
    for m in state.metrics:
        if m.expr_column_id is not None:
            mc = session.get(EntityColumn, m.expr_column_id)
            if mc is not None:
                state.target_entity_ids.add(mc.entity_id)
    if dropped:
        _trace(trace, 
            f"- forced-dropped {len(dropped)} non-grain dimension(s): "
            + ", ".join(f"entity {d.entity_id} col {d.id_column_id}" for d in dropped)
        )


def _grain_id_column(session: Session, entity_id: int) -> int | None:
    """The grain entity's own key column (mirrors the table name, e.g. agent_id on agents)."""
    cols = session.exec(
        select(EntityColumn).where(
            EntityColumn.entity_id == entity_id,
            EntityColumn.role == ColumnRole.KEY,
            EntityColumn.is_exposed == True,  # noqa: E712
        )
    ).all()
    for c in cols:
        if c.physical_name.endswith("_id"):
            return c.id
    return cols[0].id if cols else None


def _grain_check(state: PipelineState, rows: list[dict], row_count: int) -> str | None:
    """The Execute-agent self-correction signal. Returns a flag string if the breakdown looks
    wrong, else None. Two nets for the task-#49 class:
      - collapsed: grouping was requested but only 1 row came back.
      - all-identical: every metric value is the same (the all-1s over-grouping symptom)."""
    if not state.dimensions:
        return None  # no breakdown requested → nothing to check
    if row_count <= 1:
        return "collapsed to a single row despite a per-group breakdown"
    if not rows or not state.metrics:
        return None
    for m in state.metrics:
        vals = [r.get(m.alias) for r in rows if m.alias in r]
        if len(vals) > 1 and len(set(vals)) == 1:
            return f"every '{m.alias}' value is identical ({vals[0]}) — likely over-grouped"
    return None


# ── apply parser output → PipelineState ──────────────────────────────────────

def _find_category_column(session: Session, state: PipelineState, value: str) -> int | None:
    """Find the category column (in the query's target entities) whose stored values include `value` —
    so a 'what % are VALUE' question groups by that column instead of filtering it. Matches against the
    column's sample_values (case-insensitive). None if no column holds the value."""
    v = value.strip().strip("'\"").lower()
    for eid in state.target_entity_ids:
        cols = session.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == eid,
                EntityColumn.is_exposed == True,  # noqa: E712
                EntityColumn.is_deprecated == False,  # noqa: E712
            )
        ).all()
        for c in cols:
            samples = [str(s).strip().lower() for s in (c.sample_values or [])]
            if v in samples:
                return c.id
    return None


def _apply_display_columns(session: Session, state: PipelineState, display_column_ids: list[int]) -> None:
    """Add Clarify's chosen display columns to SELECT (and GROUP BY, since they're non-aggregated).
    Only columns on the GRAIN entity are safe to add — a display column from a counted child would
    re-introduce over-grouping. Deduped against what Slice already selected."""
    if not display_column_ids:
        return
    for cid in display_column_ids:
        col = session.get(EntityColumn, cid)
        if col is None or col.entity_id != state.grain_entity_id:
            continue
        if cid not in state.select_column_ids:
            state.select_column_ids.append(cid)
        if cid not in state.group_by_column_ids:
            state.group_by_column_ids.append(cid)


def _apply_metrics(session: Session, state: PipelineState, out: MetricOut, resolver) -> bool:
    """Resolve each metric's 'table.column' → column_id (scoped to candidates). Returns False if a
    non-null column can't be resolved — the caller re-plans rather than emit SQL on a guessed id."""
    allowed = {"count", "count_distinct", "sum", "avg", "min", "max"}
    for m in out.metrics:
        agg = m.agg.lower().strip()
        if agg not in allowed:
            agg = "count"
        cid: int | None = None
        if m.column is not None:
            cid = resolver.column(m.column)
            if cid is None:
                return False  # named a column outside the candidates → re-plan
        state.metrics.append(MetricSpec(agg=agg, expr_column_id=cid, alias=m.alias))
        if cid is not None:
            col = session.get(EntityColumn, cid)
            if col is not None:
                state.target_entity_ids.add(col.entity_id)
    return True


def _apply_dimensions(session: Session, state: PipelineState, out: SliceOut, resolver) -> None:
    for d in out.dimensions:
        id_col = resolver.column(d.id_column)
        if id_col is None:
            continue  # unresolved id column → skip this dimension (grain-only guard will backfill)
        id_col_obj = session.get(EntityColumn, id_col)
        entity_id = id_col_obj.entity_id
        label_id = resolver.column(d.label_column) if d.label_column else None
        # Backfill a readable label ONLY when the group id is an OPAQUE KEY (a uuid/*_id that needs a
        # human name). When the group column is itself a readable dimension (a category/text value like
        # a type or status), it IS the label — adding a SEPARATE per-row text column as its label would
        # be a different value per row and explode the groups. Decide from the column's own metadata
        # (role), not its name.
        if label_id is None and id_col_obj.role == ColumnRole.KEY:
            label_id = _best_label_column(session, entity_id)
        # guard: if the agent paired a category id with a DIFFERENT text label, drop the label — the
        # category self-labels; a distinct high-cardinality text column would fan the groups out.
        if label_id is not None and label_id != id_col and id_col_obj.role != ColumnRole.KEY:
            label_id = None
        state.dimensions.append(
            DimensionSpec(entity_id=entity_id, id_column_id=id_col, label_column_id=label_id)
        )
        state.group_by_column_ids.append(id_col)
        # Every GROUP BY column MUST also be SELECTed, or the result has no column for that axis and a
        # chart has no x-axis (the connection_type bug). Always select the id; also select the label
        # when there is a separate one (an opaque key needs its readable name too, and the id doubles
        # as the stable merge key Compose needs since display names repeat).
        if id_col not in state.select_column_ids:
            state.select_column_ids.append(id_col)
        if label_id is not None and label_id not in state.select_column_ids:
            state.select_column_ids.append(label_id)
        state.target_entity_ids.add(entity_id)
    if out.dropped_note:
        state.add_assumption(f"Slice dropped a dimension: {out.dropped_note}")


# ── markdown renderers ───────────────────────────────────────────────────────

def _retrieval_md(r: RetrievalResult) -> str:
    lines = ["## Retrieval", "| entity_id | name | grain |", "|---|---|---|"]
    for e in r.entities:
        lines.append(f"| {e.id} | {e.display_name} | {(e.grain_description or '—')[:50]} |")
    return "\n".join(lines)


def _execute_md(sql: str | None, rows: list[dict], row_count: int, flag: str | None) -> str:
    status = "✅ sane" if flag is None else f"⚠️ {flag}"
    lines = ["## Execute", f"- Rows: {row_count} · grain check: {status}"]
    if rows:
        cols = list(rows[0].keys())
        lines.append("| " + " | ".join(cols) + " |")
        lines.append("|" + "|".join("---" for _ in cols) + "|")
        for r in rows[:8]:
            lines.append("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")
    if sql:
        lines.append(f"\n```sql\n{sql}\n```")
    return "\n".join(lines)


def _is_display_clarification(q: str) -> bool:
    """A weak-model guard: a 'clarification' that is really about which COLUMNS to display is not a
    real ambiguity — display is the pipeline's own choice. Drop it so the pipeline just answers."""
    ql = q.lower()
    display_words = ("hiển thị", "cột", "column", "description", "mô tả", "trạng thái", "status",
                     "display", "show")
    # only suppress when it asks about columns/display AND isn't about an unnamed measure
    measure_words = ("nhiều nhất", "most", "top", "theo cái gì", "by what", "tiêu chí")
    return any(w in ql for w in display_words) and not any(w in ql for w in measure_words)


def _clarification_names_physical_tables(session, clar_q: str, options: list[str]) -> bool:
    """A weak-model guard: a real user never disambiguates between PHYSICAL TABLE NAMES — that is an
    internal schema detail, not a question a person can answer. When the clarification text or its
    options mention 2+ actual table names (e.g. 'workflow_nodes' vs 'workflow_layers'), the model has
    surfaced an implementation choice it should resolve itself (the obvious concept table). Suppress
    it so the pipeline proceeds with the natural table rather than asking the user schema trivia."""
    blob = (clar_q + " " + " ".join(options or [])).lower()
    hits = 0
    for e in session.exec(select(Entity).where(Entity.is_exposed == True)).all():  # noqa: E712
        table = (e.physical_path.split(".")[-1] if e.physical_path else "").lower()
        # only count multi-word/underscored physical names — a bare word like 'agents' could be
        # legitimate natural language, but 'workflow_nodes' only appears if the model leaked schema.
        if table and "_" in table and table in blob:
            hits += 1
    return hits >= 2


def _question_uses_glossary(session, question: str) -> bool:
    """True if the question contains a business-glossary term (by name or synonym). Such a phrase is
    well-defined (its predicate is applied by the Filter step), so a clarification about it is
    spurious — the weak model over-asks about domain terms, so we suppress deterministically."""
    from src.database.models import BusinessGlossaryTerm

    ql = question.lower()
    for t in session.exec(select(BusinessGlossaryTerm)).all():
        for name in (t.term, *(t.synonyms or [])):
            if name and name.lower() in ql:
                return True
    return False


def _fail(trace: list[str], msg: str) -> V3Result:
    # record the failure reason IN the trace so debug dumps show why a (sub-)question failed —
    # otherwise a failed sub silently vanishes and the answer looks incomplete for no visible reason.
    _trace(trace, f"## FAILED\n- ❌ {msg}")
    return V3Result(success=False, error=msg, trace_md="\n\n---\n\n".join(trace))
