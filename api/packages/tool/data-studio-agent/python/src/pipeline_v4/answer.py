"""Pipeline v4 end to end: question (+ conversation) → sub-questions → profile → QuerySpec/SQL → rows →
one answer, charts, follow-ups.

  understand       decompose      (standalone question + 1-3 sub-questions, from the conversation)
  per sub-question, in parallel:
    step 3 find    find_profile   (keywords, pre-search, table/term/value pickers)
    step 4 plan    plan_query     (kind router + readers, specialists, compile + fix rounds)
    step 5 run     run_query      (EXPLAIN, run read-only, sanity warnings)
  step 6 present   present_parts  (one answer over all parts; charts and follow-ups per part)

Everything is reported through `on_event` as it happens (the API streams it as SSE):
  step              {step, status: started|done, label, part?, …}
  decompose         {standalone, parts: [{id, question}], notes}
  agent_started / agent_done / agent_delta / tool_started / tool_done / answer_delta / answer_reset
                    from every agent run, keyed by run_id
  keywords, intent, spec_errors, sql, result   per sub-question: carry `part`
  answer, charts (each chart carries `part`), follow_ups, timings, done
Events of a sub-question's steps 3-5 carry `part` (q1, q2, …).
"""

import asyncio
from dataclasses import dataclass, field
from typing import Any

from src.database.mongodb import get_async_mongo_db
from src.pipeline_v4.agents.base import EventSink
from src.pipeline_v4.agents.decompose import decompose, make_decomposer
from src.pipeline_v4.agents.parts import SubQuestion
from src.pipeline_v4.catalog import Catalog, load_catalog
from src.pipeline_v4.context import Names, build_context
from src.pipeline_v4.dremio import AsyncDremio
from src.pipeline_v4.find import find_profile, make_find_agents
from src.pipeline_v4.history import load_history, render_history
from src.pipeline_v4.plan import (
    PlanResult,
    business_today,
    make_plan_agents,
    plan_query,
)
from src.pipeline_v4.present import (
    PartView,
    Presentation,
    make_present_agents,
    present_parts,
)
from src.pipeline_v4.retrieve import MeiliProfileSearch, Retrieved
from src.pipeline_v4.run import RunResult, run_query
from src.pipeline_v4.timing import Timing, span, track
from src.settings import Settings

STEPS = {"understand": "Understanding the question", "find": "Finding the data", "plan": "Building the query",
         "run": "Running the query", "present": "Writing the answer"}


@dataclass
class PartResult:
    id: str
    question: str
    r: Retrieved
    plan: PlanResult | None = None
    result: RunResult | None = None
    spec: dict[str, Any] | None = None
    sql: str | None = None
    error: str | None = None


@dataclass
class V4Answer:
    question: str
    presentation: Presentation
    standalone: str = ""
    parts: list[PartResult] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)            # from the decomposer
    timings: dict[str, Any] = field(default_factory=dict)

    # the first part, for callers that show one result
    @property
    def sql(self) -> str | None:
        return self.parts[0].sql if self.parts else None

    @property
    def spec(self) -> dict[str, Any] | None:
        return self.parts[0].spec if self.parts else None

    @property
    def result(self) -> RunResult | None:
        return self.parts[0].result if self.parts else None


def timing_dict(t: Timing) -> dict[str, Any]:
    return {"name": t.name, "seconds": round(t.seconds, 3), "ok": t.ok, "children": [timing_dict(c) for c in t.children]}


async def _noop(kind: str, data: dict[str, Any]) -> None:
    return None


def part_sink(emit: EventSink, part_id: str) -> EventSink:
    """Every event of one sub-question carries its id."""
    async def sink(kind: str, data: dict[str, Any]) -> None:
        await emit(kind, {**data, "part": part_id})
    return sink


async def solve_part(part: SubQuestion, cat: Catalog, h: Names, settings: Settings, search: MeiliProfileSearch,
                     data_source_ids: list[str] | None, emit: EventSink) -> PartResult:
    """Steps 3-5 for one sub-question."""
    async def step(name: str, status: str, **extra: Any) -> None:
        await emit("step", {"step": name, "status": status, "label": STEPS[name], **extra})

    question = part.question
    await step("find", "started")
    r = await find_profile(question, cat, h, make_find_agents(settings, cat, h, search, data_source_ids),
                           search, data_source_ids, on_event=emit)
    await step("find", "done", tables=[h.of(t) for t in r.tables], lookups=[h.of(t) for t in r.lookups],
               metrics=[h.of(m) for m in r.metrics], terms=[h.of(g) for g in r.glossary],
               values=[f"{h.col_ref(v.column_id)} = {v.value}" for v in r.values], notes=r.notes)

    await step("plan", "started")
    ctx = await build_context(r, cat, h)
    plan = await plan_query(question, r.keywords, ctx, r, cat, make_plan_agents(settings, cat, h, search, data_source_ids),
                            business_today(cat, r.tables), on_event=emit)
    spec = plan.spec.model_dump(mode="json", exclude_defaults=True) if plan.spec else None
    await step("plan", "done", status_=plan.status, rounds=plan.rounds, message=plan.message,
               errors=[e.model_dump() for e in plan.errors], assumptions=plan.assumptions)
    if plan.compiled is not None:
        await emit("sql", {"sql": plan.compiled.sql, "spec": spec, "assumptions": plan.assumptions})

    result = None
    if plan.status == "ok" and plan.compiled is not None and plan.spec is not None:
        await step("run", "started")
        result = await run_query(plan.compiled, plan.spec, cat, AsyncDremio(settings))
        await emit("result", {"status": result.status, "stage": result.stage, "error": result.error,
                              "columns": [c.model_dump() for c in result.columns], "rows": result.rows,
                              "row_count": result.row_count, "elapsed_ms": result.elapsed_ms,
                              "warnings": result.warnings})
        await step("run", "done", status_=result.status)
    return PartResult(id=part.id, question=question, r=r, plan=plan, result=result, spec=spec,
                      sql=plan.compiled.sql if plan.compiled else None)


async def _solve(part: SubQuestion, *args: Any) -> PartResult:
    """A crash in one sub-question does not stop the others."""
    emit: EventSink = args[-1]
    with span(f"part {part.id}"):
        try:
            return await solve_part(part, *args)
        except Exception as err:  # noqa: BLE001 — reported, the part answers "failed"
            await emit("error", {"error": f"{type(err).__name__}: {err}"})
            return PartResult(id=part.id, question=part.question, r=Retrieved(question=part.question),
                              error=f"{type(err).__name__}: {err}")


async def ask_v4(question: str, settings: Settings, on_event: EventSink | None = None,
                 data_source_ids: list[str] | None = None, conversation_id: str | None = None) -> V4Answer:
    emit = on_event or _noop

    async def step(name: str, status: str, **extra: Any) -> None:
        await emit("step", {"step": name, "status": status, "label": STEPS[name], **extra})

    with track(question) as timings:
        db = get_async_mongo_db()
        cat = await load_catalog(db)
        h = Names(cat)
        search = MeiliProfileSearch(settings)

        await step("understand", "started")
        history = render_history(await load_history(db, conversation_id, h))
        d = await decompose(question, history, make_decomposer(settings, cat, h, search, data_source_ids), emit)
        await emit("decompose", {"standalone": d.standalone, "parts": [p.model_dump() for p in d.parts],
                                 "notes": d.notes})
        await step("understand", "done", parts=len(d.parts))

        parts = await asyncio.gather(*(_solve(p, cat, h, settings, search, data_source_ids, part_sink(emit, p.id))
                                       for p in d.parts))

        await step("present", "started")
        views = [PartView(p.id, p.question, p.plan, p.result, p.r) for p in parts]
        shown = await present_parts(d.standalone, views, cat, h, make_present_agents(settings, h), on_event=emit)
        await step("present", "done", status_=shown.status, notes=shown.notes)

    answer = V4Answer(question=question, presentation=shown, standalone=d.standalone, parts=list(parts),
                      notes=d.notes, timings=timing_dict(timings))
    await emit("timings", answer.timings)
    await emit("done", {"status": shown.status})
    return answer
