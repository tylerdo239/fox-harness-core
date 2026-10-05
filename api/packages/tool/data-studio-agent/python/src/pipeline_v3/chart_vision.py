"""Vision-based chart review — judges the ACTUAL rendered chart image, not just its spec.

The frontend renders the recommended chart, screenshots it to a PNG, and POSTs the image here.
A vision model looks at what the user actually sees — empty plot, unreadable labels, wrong chart
type for the comparison — and decides whether it answers the question. If not, a chart agent
re-picks the spec from the real columns + the vision feedback, and the new spec is returned for
the frontend to re-render. This catches visual problems a spec-only text review cannot.

Kept as a separate FE-driven request (not part of the SSE stream) so the main pipeline stays
one-directional: stream → done, then an optional vision follow-up refines the chart.
"""

from __future__ import annotations

from agno.agent import Agent
from agno.media import Image
from agno.models.openai.like import OpenAILike
from pydantic import BaseModel, Field

from src.pipeline_v3.agents import build_chart_fix_agent
from src.pipeline_v3.orchestrator import _guard_chart_fields
from src.pipeline_v3.pandas_exec import run_pandas_code

import pandas as pd


class VisionVerdict(BaseModel):
    satisfied: bool = Field(description="true if the rendered chart clearly answers the question")
    feedback: str = Field(default="", description="if not satisfied: what is visually wrong")


async def review_chart_image(
    model: OpenAILike,
    question: str,
    image_png: bytes,
    columns: list[str],
    chart: dict,
) -> dict:
    """Judge the rendered chart image. The vision model ONLY reviews — on rejection it loops back to
    the CHART AGENT (chart_fix) to REVISE the chart; the reviewer never edits fields itself. Returns
    {satisfied, feedback, chart} — chart is the (possibly revised) spec to render."""
    verdict = await _judge(model, question, image_png, chart)
    if verdict.satisfied or not verdict.feedback:
        return {"satisfied": True, "feedback": "", "chart": chart}

    # loop back to the chart agent to revise — the ONLY thing allowed to change the chart.
    sql_rows = chart.get("rows") or []
    base_cols = list(sql_rows[0].keys()) if sql_rows else columns
    fix_agent = build_chart_fix_agent(model)
    fix_run = await fix_agent.run(
        f"Question: {question}\n\nCurrent chart: type={chart.get('type')}, x={chart.get('x')}, "
        f"y={chart.get('y')}, title={chart.get('title')}, "
        f"transform_code={chart.get('transform_code', '')!r}\n"
        f"Available columns: {base_cols}\nSample rows: {sql_rows[:5]}\n\n"
        f"The RENDERED chart was visually rejected: {verdict.feedback}\nReturn ONE corrected chart.")
    if not (fix_run.ok and fix_run.result.charts):
        return {"satisfied": True, "feedback": verdict.feedback, "chart": chart}  # can't fix → keep

    fixed = fix_run.result.charts[0]
    # KEEP THE ORIGINAL CHART TYPE. A vision review fixes the FIELDS / data of THIS chart; it must
    # NOT change bar↔pie↔line — the type is the chart agent's proposal-time diversity choice, and
    # flipping it (e.g. a pie becoming a second bar) both loses variety and desyncs streaming vs
    # reload. So ignore fixed.chart_type here.
    ctype = (chart.get("type") or "bar").lower()
    transform_code = (fixed.transform_code or "").strip()
    # re-derive this chart's data from the SQL rows via the (possibly new) transform
    new_rows = sql_rows
    if transform_code:
        rows, err = run_pandas_code(transform_code, {"df": pd.DataFrame(sql_rows)})
        if not err:
            new_rows = rows
    cols = list(new_rows[0].keys()) if new_rows else base_cols
    # validate the chart agent's fields exist; anti-empty guard only if they don't
    x, ys = fixed.chart_x, list(fixed.chart_y)
    if not (x in cols and ys and all(c in cols for c in ys)):
        x, ys = _guard_chart_fields(x, ys, cols)
    if x is None or not ys:  # nothing plottable → keep the original chart
        return {"satisfied": True, "feedback": verdict.feedback, "chart": chart}
    new_chart = {"type": ctype, "x": x, "y": ys, "title": fixed.title or chart.get("title", question),
                 "recommended": chart.get("recommended", False), "rows": new_rows,
                 "value_field": None, "transform_code": transform_code}
    return {"satisfied": False, "feedback": verdict.feedback, "chart": new_chart}


async def _judge(model: OpenAILike, question: str, image_png: bytes, chart: dict) -> VisionVerdict:
    agent = Agent(
        model=model,
        output_schema=VisionVerdict,
        use_json_mode=True,
        instructions=[
            "You are shown an image of ONE chart. It is one of SEVERAL charts built for this question "
            "(e.g. a bar for the counts AND a separate pie for the percentages) — you are judging only "
            "the VISUAL QUALITY of THIS one image, not whether it single-handedly shows everything.",
            "Judge, by LOOKING at the image, whether THIS chart renders correctly and readably.",
            "**NOT satisfied ONLY for a VISUAL defect:** the plot area is empty / has no bars/lines/"
            "points; axis or category labels are missing or unreadable; the bars are all the same "
            "height when the data clearly differs; or the chart type plainly hides the comparison.",
            "**SATISFIED otherwise. Do NOT reject a chart for showing one measure and not another** — a "
            "bar that shows the COUNT is fine even if the question also mentions a percentage (the "
            "percentage lives on a DIFFERENT chart). **Never ask a bar/line to add a percentage/share "
            "column; that belongs on a pie, not this chart.** Judge only what is wrong with the pixels "
            "you see.",
            "Give concrete VISUAL feedback when not satisfied.",
        ],
    )
    run = await agent.arun(
        f"Question: {question}\nChart spec: type={chart.get('type')}, x={chart.get('x')}, "
        f"y={chart.get('y')}\n\nDoes this rendered chart answer the question?",
        images=[Image(content=image_png)],
    )
    content = run.content
    if isinstance(content, VisionVerdict):
        return content
    # parse failure → treat as satisfied (don't block on a flaky judge)
    return VisionVerdict(satisfied=True, feedback="")
