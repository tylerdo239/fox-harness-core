"""Executes a sub-question DAG: parallel where independent, sequential where dependent.

Each sub-question runs the full single-question pipeline (run_pipeline_v2) and keeps its OWN
result + chart — charts are never merged across sub-questions. A dependent sub-question has the
result rows of the sub-questions it depends on injected into its question text before it runs
(the 'inject result rows as text' strategy), so a later question can build on an earlier answer.

Execution proceeds in topological LAYERS: every sub-question whose dependencies are all done runs
concurrently; when the layer finishes, the next becomes runnable. Progress for each sub-question is
forwarded through on_event, tagged with its id so the UI can show a section per sub-question.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from sqlmodel import Session

from src.pipeline_v2.decompose_v2 import SubQuestion
from src.services.dremio_client import DremioClient
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.vector_store import VectorStore

# on_event(event_type, payload) — payload for sub-question events carries {"sub_id": ...}
EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]

_MAX_INJECTED_ROWS = 20


async def run_dag(
    session: Session,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    dremio_client: DremioClient,
    sub_questions: list[SubQuestion],
    run_one,  # the single-question pipeline: async (session, ..., question, on_event) -> dict
    on_event: EventSink,
) -> dict[str, dict[str, Any]]:
    """Runs the DAG, returns {sub_id: packaged_result}. `run_one` is injected (run_pipeline_v2)
    so this module doesn't import the orchestrator (avoids a cycle)."""
    by_id = {s.id: s for s in sub_questions}
    results: dict[str, dict[str, Any]] = {}
    remaining = set(by_id)

    # which sub-questions are DEPENDED-UPON — a later sub-question needs their result. Those must
    # return an identifying column (id) so the dependent can filter by an exact value, not a name.
    has_dependents = {dep for s in sub_questions for dep in s.depends_on}

    while remaining:
        # a sub-question is runnable when every dependency has a result
        runnable = [
            sid for sid in remaining
            if all(dep in results for dep in by_id[sid].depends_on)
        ]
        if not runnable:
            # dependency cycle or unresolved dep — break to avoid deadlock, mark the rest failed
            for sid in remaining:
                results[sid] = {"success": False, "question": by_id[sid].question,
                                "clarifying_question": "Could not resolve sub-question dependencies."}
            break

        # run this layer concurrently
        async def _run(sid: str) -> tuple[str, dict[str, Any]]:
            sub = by_id[sid]
            question = _inject_dependencies(sub, results)
            if sid in has_dependents:
                # a later sub-question will filter by this result — make sure it returns the
                # identifying column (id), not just a display name a filter can't reliably use.
                question += (
                    "\nNOTE: a later step will use THIS result to filter — include the "
                    "identifying id column(s) of the answer's entity in the output, not just a "
                    "name, so the exact entity can be referenced later."
                )
            await on_event("sub_started", {"sub_id": sid, "question": sub.question})

            async def sub_sink(event_type: str, payload: dict[str, Any]) -> None:
                # tag every inner event with the sub-question id so the UI groups them
                await on_event(event_type, {**payload, "sub_id": sid})

            packaged = await run_one(
                session, llm_client, embedding_client, vector_store, dremio_client,
                question, on_event=sub_sink,
            )
            await on_event("sub_done", {"sub_id": sid})
            return sid, packaged

        layer_results = await asyncio.gather(*(_run(sid) for sid in runnable))
        for sid, packaged in layer_results:
            results[sid] = packaged
            remaining.discard(sid)

    return results


def _inject_dependencies(sub: SubQuestion, results: dict[str, dict[str, Any]]) -> str:
    """Render the result rows of each dependency into this sub-question's text, so a dependent
    question ('for the top workflow found, ...') can be answered with the concrete prior values."""
    if not sub.depends_on:
        return sub.question

    context_lines = []
    for dep_id in sub.depends_on:
        dep = results.get(dep_id)
        if not dep or not dep.get("success"):
            continue
        rows = dep.get("rows") or []
        lines = [f'Result of a previous step — question: "{dep.get("question", dep_id)}":']
        if not rows:
            lines.append("  (no rows)")
        for r in rows[:_MAX_INJECTED_ROWS]:
            # explicit key=value so the model can lift exact filter values (ids especially)
            lines.append("  " + ", ".join(f"{k}={v!r}" for k, v in r.items()))
        context_lines.append("\n".join(lines))

    if not context_lines:
        return sub.question
    prior = "\n\n".join(context_lines)
    return (
        f"{prior}\n\n"
        f"Now answer: {sub.question}\n"
        f"IMPORTANT: use the EXACT values from the previous result above as your filter — "
        f"e.g. if it names an id, filter by that exact id (do not re-derive or re-rank). If the "
        f"previous result is missing the value you need to filter by, answer for what you can."
    )
