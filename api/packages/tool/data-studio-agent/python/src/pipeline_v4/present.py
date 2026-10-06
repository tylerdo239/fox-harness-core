"""Step 6: turn the result into what the user sees: a written answer, charts, follow-up questions.

  answer      TextAgent, streamed. Code checks every number it quotes against the result, the
              question and the notes; if it quotes others, it rewrites once with that feedback
  charts      chart agent (ChartTools checks each chart against the result columns and rows); code
              builds the chart data (time steps formatted, pie shares computed, rows projected),
              adds stat cards for a single row, a default bar when nothing fits, and always a table
  follow-ups  follow-up agent (one structured call), given what the profile holds that this query
              did not use; code keeps only suggestions whose names exist, in the question's language
The three run in parallel. Clarify / cannot answer / failed steps get a written reply from code.
"""

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from src.pipeline_v4 import chart_data
from src.pipeline_v4.agents.base import (
    AgentFailed,
    EventSink,
    StructuredAgent,
    TextAgent,
    ToolAgent,
)
from src.pipeline_v4.agents.parts import ChartsOut, FollowUpsOut
from src.pipeline_v4.agents.specialists import (
    answer_writer,
    chart_agent,
    follow_up_agent,
)
from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.chart_data import Dataset
from src.pipeline_v4.compiler import OutputColumn
from src.pipeline_v4.context import Names, UnknownName, one_line
from src.pipeline_v4.plan import PlanResult
from src.pipeline_v4.retrieve import Retrieved
from src.pipeline_v4.run import RunResult
from src.pipeline_v4.spec import QuerySpec
from src.pipeline_v4.timing import timed
from src.pipeline_v4.tools.step6 import MAX_BARS
from src.settings import Settings

PROMPT_ROWS = 30          # rows the answer writer sees
MAX_FOLLOW_UPS = 3
SMALL_NUMBER = 12         # small counts ("3 agents", "12 months") are not checked


@dataclass
class Presentation:
    status: Literal["answered", "empty", "clarify", "cannot_answer", "failed"]
    answer_markdown: str
    charts: list[dict[str, Any]] = field(default_factory=list)
    follow_ups: list[dict[str, Any]] = field(default_factory=list)
    options: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)       # for the trace (e.g. numbers the answer invented)
    trace: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class PresentAgents:
    answer: TextAgent
    follow_ups: StructuredAgent[FollowUpsOut]
    settings: Settings

    def charts(self, original: Dataset) -> ToolAgent[ChartsOut]:
        return chart_agent(self.settings, original)  # the toolkit checks against this result


def make_present_agents(settings: Settings, h: Names) -> PresentAgents:
    return PresentAgents(answer=answer_writer(settings), follow_ups=follow_up_agent(settings), settings=settings)


# ── formatting ──

def format_value(value: Any, col: OutputColumn | None) -> Any:
    """Time steps as people write them (2026-02, 2026-Q1, 2026-02-14), numbers with ≤ 2 decimals."""
    if col is not None and col.time_grain and isinstance(value, str) and len(value) >= 10:
        try:
            moment = datetime.fromisoformat(value.replace(" ", "T")[:19])
        except ValueError:
            return value
        return {"year": f"{moment:%Y}", "quarter": f"{moment.year}-Q{(moment.month - 1) // 3 + 1}",
                "month": f"{moment:%Y-%m}"}.get(col.time_grain, f"{moment:%Y-%m-%d}")
    if isinstance(value, float):
        return int(value) if value.is_integer() else round(value, 2)
    return value


def formatted_rows(rows: list[dict[str, Any]], columns: list[OutputColumn]) -> list[dict[str, Any]]:
    by_name = {c.name: c for c in columns}
    return [{k: format_value(v, by_name.get(k)) for k, v in r.items()} for r in rows]


def _visible(columns: list[OutputColumn]) -> list[OutputColumn]:
    """Columns a person reads: an id is hidden when its name column is there."""
    names = {c.name for c in columns}
    return [c for c in columns if f"{c.name}_label" not in names]


def _table_of(c: OutputColumn, columns: list[OutputColumn], cat: Catalog) -> str | None:
    """The table a result column comes from: a name column's table is the table its id identifies."""
    if c.kind == "label":
        dim = next((d for d in columns if f"{d.name}_label" == c.name), None)
        return _table_of(dim, columns, cat) if dim is not None else None
    if c.kind == "metric" and c.metric_id in cat.metrics:
        return cat.metrics[c.metric_id].get("entity_id")
    if c.column_id in cat.columns:
        return cat.columns[c.column_id].entity_id
    return None


def _identifies(c: OutputColumn, cat: Catalog) -> bool:
    col = cat.columns.get(c.column_id or "")
    t = cat.tables.get(col.entity_id) if col else None
    return bool(col and t and col.id in t.profile.grain_key_column_ids)


def column_label(c: OutputColumn, columns: list[OutputColumn], cat: Catalog) -> str:
    """What a person calls a result column, from the profile's display names (a name column, or an
    id shown without one, is named after its table)."""
    tid = _table_of(c, columns, cat)
    table = cat.tables.get(tid or "")
    if (c.kind == "label" or (c.kind == "dimension" and not c.time_grain and _identifies(c, cat))) and table:
        text = table.display_name
    elif c.kind == "metric" and c.metric_id in cat.metrics:
        m = cat.metrics[c.metric_id]
        text = m.get("display_name") or m.get("name") or c.name
    elif c.column_id in cat.columns:
        text = cat.columns[c.column_id].display_name
    else:
        text = c.name
    return text + (f" ({c.unit})" if c.unit else "")


def column_labels(columns: list[OutputColumn], cat: Catalog) -> dict[str, str]:
    return {c.name: column_label(c, columns, cat) for c in columns}


def _legend(columns: list[OutputColumn], cat: Catalog, h: Names) -> list[str]:
    out = []
    for c in _visible(columns):
        tid = _table_of(c, columns, cat)
        table = f"“{cat.tables[tid].display_name}”" if tid in cat.tables else ""
        if c.kind == "label":
            what = f"name of each {table}" if table else "name"
        elif c.kind == "metric" and c.metric_id in cat.metrics:
            m = cat.metrics[c.metric_id]
            what = f"metric “{m.get('display_name') or m.get('name')}”" + (f" of {table}" if table else "")
        elif c.kind == "derived":
            what = "computed value"
        elif c.column_id in cat.columns:
            col = cat.columns[c.column_id]
            what = f"“{col.display_name}” of {table}" + (f" by {c.time_grain}" if c.time_grain else "")
        else:
            what = c.kind
        out.append(f"- {c.name}: {what}" + (f" [{c.unit}]" if c.unit else ""))
    return out


def _tables_block(columns: list[OutputColumn], cat: Catalog) -> list[str]:
    """The tables behind the result columns, as the profile describes them (what their rows are)."""
    out = []
    for tid in dict.fromkeys(t for c in columns if (t := _table_of(c, columns, cat)) in cat.tables):
        t = cat.tables[tid]
        line = f"- “{t.display_name}”"
        if t.grain_description:
            line += f": one row = {one_line(t.grain_description)}"
        if t.description:
            line += f" — {one_line(t.description)}"
        out.append(line)
    return out


def _table(rows: list[dict[str, Any]], columns: list[OutputColumn]) -> str:
    cols = [c.name for c in _visible(columns)] or (list(rows[0]) if rows else [])
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join("" if r.get(c) is None else str(r.get(c)) for c in cols) + " |" for r in rows]
    return "\n".join(lines)


def rows_meaning(plan: PlanResult, h: Names) -> str:
    """What one row of the result is, from the question type (so the writer reads the rows right)."""
    intent, spec = plan.intent, plan.spec
    if intent is None or spec is None:
        return ""
    period = next((p.label or f"{p.start} to {p.end}" for p in spec.periods.values()), "")
    within = f" in {period}" if period else ""
    listed = intent.listed_table or (h.of(spec.entity_id) if spec.entity_id else "")
    related = intent.related_table or ""
    return {
        "total": "The single row is the total asked for.",
        "grouped": "Each row is one group of the split, with its numbers.",
        "top_n": f"The rows are the top {intent.top_n or ''} groups, already ranked.".replace("  ", " "),
        "trend": f"Each row is one {intent.time_grain or 'time step'}, in order.",
        "compare_periods": "Each row compares the current period (…_cur) with the earlier one (…_prev); "
                           "…_growth_pct is the change in %.",
        "list_rows": f"Each row is one {listed}.",
        "rows_with": (f"There is one count: the number of {listed} that have {related}{within}." if intent.count_rows
                      else f"Each row is a {listed} that HAS {related}{within}. These rows are the answer."),
        "rows_without": (f"There is one count: the number of {listed} that have NO {related}{within}." if intent.count_rows
                         else f"Each row is a {listed} that has NO {related}{within}. These rows are the answer."),
        "per_summary": "The numbers summarize values computed per group first.",
    }.get(intent.kind, "")


def _period_notes(spec: QuerySpec) -> list[str]:
    return [f"period {p.label or k}: {p.start} to {p.end} (end excluded)" for k, p in spec.periods.items()]


# ── the number check ──

_NUMBER = re.compile(r"\d[\d.,]*\d|\d")


def _readings(token: str) -> set[float]:
    """A number as written can mean several values: 1.250 (Vietnamese thousands) or 1.25."""
    out = set()
    for text in (token.replace(",", ""), token.replace(".", "").replace(",", "."), token.replace(",", ".")):
        try:
            out.add(float(text))
        except ValueError:
            continue
    return out


def numbers_allowed(question: str, rows: list[dict[str, Any]], notes: list[str],
                    additive: set[str] | frozenset[str] = frozenset()) -> set[float]:
    """Numbers the answer may quote: of the question, the notes and the rows, plus for each measure that
    can be added up (counts, sums) its total and every row's share of it in % ('28.501 in all, 60,7%')."""
    allowed: set[float] = {float(len(rows))}
    for name in additive:
        values = [float(r[name]) for r in rows if isinstance(r.get(name), int | float) and not isinstance(r.get(name), bool)]
        total = sum(values)
        allowed.add(total)
        if total:
            for v in values:
                share = v / total * 100
                allowed |= {share, float(round(share)), round(share, 1)}
    for text in [question, *notes]:
        for token in _NUMBER.findall(text):
            allowed |= _readings(token)
    for r in rows:
        for v in r.values():
            if isinstance(v, bool):
                continue
            if isinstance(v, int | float):
                allowed.add(float(v))
            elif isinstance(v, str):
                for token in _NUMBER.findall(v):
                    allowed |= _readings(token)
    return allowed


def unknown_numbers(answer: str, allowed: set[float]) -> list[str]:
    """Numbers the answer quotes that are in none of the allowed sources (rounding tolerated)."""
    out = []
    for token in _NUMBER.findall(answer):
        readings = _readings(token)
        if any(x <= SMALL_NUMBER and x == int(x) for x in readings):
            continue
        if any(abs(x - a) <= max(0.006, abs(a) * 0.005) for x in readings for a in allowed):
            continue
        out.append(token)
    return list(dict.fromkeys(out))


# ── charts (code part) ──

def chart_payload(pick: Any, rows: list[dict[str, Any]], columns: list[OutputColumn]) -> dict[str, Any]:
    keep = [pick.x, *pick.y]
    data = [{k: r.get(k) for k in keep} for r in rows]
    by_name = {c.name: c for c in columns}
    if by_name.get(pick.x) and by_name[pick.x].time_grain:
        data.sort(key=lambda r: str(r.get(pick.x)))
    y = list(pick.y)
    if pick.type in ("pie", "donut"):
        total = sum(float(r.get(y[0]) or 0) for r in data)
        share = f"{y[0]}_share_pct"
        for r in data:
            r[share] = round(float(r.get(y[0]) or 0) / total * 100, 1) if total else None
        y = [share]
    return {"type": pick.type, "x": pick.x, "y": y, "title": pick.title, "recommended": pick.recommended,
            "units": {n: by_name[n].unit for n in pick.y if n in by_name and by_name[n].unit}, "rows": data}


def stat_cards(rows: list[dict[str, Any]], columns: list[OutputColumn],
               labels: dict[str, str] | None = None) -> list[dict[str, Any]]:
    labels = labels or {}
    return [{"type": "stat", "title": labels.get(c.name, c.name).removesuffix(f" ({c.unit})" if c.unit else ""),
             "value": rows[0].get(c.name), "unit": c.unit, "recommended": i == 0}
            for i, c in enumerate(c for c in columns if c.kind in ("metric", "derived"))]


def with_labels(chart: dict[str, Any], labels: dict[str, str]) -> dict[str, Any]:
    """The chart with `labels`: what to show for each of its fields (axes, legend, table headers)."""
    fields = [chart.get("x"), *(chart.get("y") or []), *(chart.get("columns") or [])]
    out = {f: labels[f] for f in fields if f and f in labels}
    for f in fields:   # a pie's computed share of a measure
        if f and f.endswith("_share_pct") and (base := f.removesuffix("_share_pct")) in labels:
            out[f] = f"{labels[base]} (%)"
    return {**chart, "labels": out} if out else chart


def original_dataset(rows: list[dict[str, Any]], columns: list[OutputColumn], cat: Catalog) -> Dataset:
    """The query result as the chart agent's first dataset: its labels, and which measures can be added
    up (counts and sums; not distinct counts, averages or ratios)."""
    additive = set()
    for c in columns:
        m = cat.metrics.get(c.metric_id or "") if c.kind == "metric" else None
        if m and m.get("kind") != "ratio" and m.get("aggregation") in ("count", "sum"):
            additive.add(c.name)
    return chart_data.Dataset(rows, columns, column_labels(columns, cat), additive, "the query result")


def default_bar(rows: list[dict[str, Any]], columns: list[OutputColumn], question: str) -> dict[str, Any] | None:
    """A bar (or a line over time) when the chart agent made nothing; none when there are too many groups
    to read (the data table shows them)."""
    visible = _visible(columns)
    x = next((c.name for c in visible if c.kind in ("label", "dimension")), None)
    y = next((c.name for c in visible if c.kind in ("metric", "derived")), None)
    if x is None or y is None:
        return None
    if len({str(r.get(x)) for r in rows}) > MAX_BARS:
        return None
    kind = "line" if any(c.name == x and c.time_grain for c in columns) else "bar"
    pick = type("Pick", (), {"type": kind, "x": x, "y": [y], "title": question, "recommended": True})()
    return chart_payload(pick, rows, columns)


def data_table(rows: list[dict[str, Any]], columns: list[OutputColumn]) -> dict[str, Any]:
    names = [c.name for c in _visible(columns)] or (list(rows[0]) if rows else [])
    return {"type": "table", "columns": names, "rows": [{k: r.get(k) for k in names} for r in rows],
            "title": "Bảng dữ liệu", "recommended": False}


# ── follow-ups (what the query did not use) ──

def follow_up_context(question: str, spec: QuerySpec | None, r: Retrieved, cat: Catalog, h: Names) -> str:
    used: set[str] = set()
    if spec is not None:
        used |= {d.column_id for d in spec.dimensions} | {f.column_id for f in spec.filters}
        used |= {m.metric_id for m in spec.metrics} | set(spec.segments) | set(spec.columns)
    lines = [f"User's question: {question}", "", "Used by this answer: " + (", ".join(h.of(u) for u in used if u in h.name_of) or "-"),
             "", "Not used yet, on the same tables:"]
    always = {f.column_id for t in r.all_tables for f in cat.tables[t].profile.default_filters}  # applied anyway
    for tid in r.all_tables:
        for c in h.columns_of(tid):
            if c.id not in used | always and (c.role == "dimension" or c.profile.value_catalog) and not c.is_pii:
                lines.append(f"- {h.of(c.id)}" + (f" — {c.display_name}" if c.display_name != c.physical_name else ""))
    related = {j.to_entity_id if j.from_entity_id in r.all_tables else j.from_entity_id
               for j in cat.joins if (j.from_entity_id in r.all_tables) != (j.to_entity_id in r.all_tables)}
    related = {t for t in related if t in h.name_of}
    if related:
        lines += ["", "Related tables:"] + [f"- {h.of(t)}: {cat.tables[t].grain_description or cat.tables[t].display_name}"
                                            for t in sorted(related, key=h.of)]
    metrics = [mid for mid, m in cat.metrics.items() if mid not in used and m.get("entity_id") in set(r.all_tables) | related]
    if metrics:
        lines += ["", "Metrics:"] + [f"- {h.of(m)}" for m in sorted(metrics, key=h.of)[:12]]
    terms = [gid for gid in cat.glossary if gid not in used and gid in h.name_of]
    if terms:
        lines += ["", "Business terms:"] + [f"- {h.of(g)}" for g in terms[:8]]
    return "\n".join(lines)


def checked_follow_ups(question: str, suggestions: list[Any], h: Names) -> tuple[list[dict[str, Any]], list[str]]:
    """Keep suggestions that rely only on profile names, are in the question's language and are new;
    names come back canonical. At most MAX_FOLLOW_UPS."""
    kept: list[dict[str, Any]] = []
    dropped: list[str] = []
    seen = {" ".join(question.lower().split())}
    for s in suggestions:
        text = " ".join(s.question.split())
        key = text.lower()
        if not text or key in seen or (not question.isascii() and text.isascii()):
            dropped.append(text)
            continue
        try:
            names = [h.of(h.resolve(n)) for n in s.based_on]
        except UnknownName:
            dropped.append(text)
            continue
        seen.add(key)
        kept.append({"question": text, "based_on": names})
        if len(kept) == MAX_FOLLOW_UPS:
            break
    return kept, dropped


# ── flow ──

def _reply_without_result(plan: PlanResult | None, run: RunResult | None) -> Presentation | None:
    if plan is None:
        return Presentation(status="failed", answer_markdown="Không tìm được dữ liệu phù hợp để trả lời câu hỏi này.")
    if plan.status == "clarify":
        options = "\n".join(f"- {o}" for o in plan.options)
        return Presentation(status="clarify", answer_markdown=f"{plan.message}\n\n{options}".strip(), options=plan.options)
    if plan.status == "cannot_answer":
        return Presentation(status="cannot_answer", answer_markdown=plan.message or "Dữ liệu hiện có không trả lời được câu hỏi này.")
    if plan.status == "failed":
        detail = "; ".join(e.message for e in plan.errors[:3]) or plan.message or ""
        return Presentation(status="failed", answer_markdown=f"Chưa tạo được truy vấn cho câu hỏi này. {detail}".strip())
    if run is None or run.status == "failed":
        detail = run.error if run else ""
        return Presentation(status="failed", answer_markdown=f"Truy vấn chạy không thành công: {detail}".strip())
    return None


@dataclass
class PartView:
    """What step 6 needs of one sub-question."""
    id: str
    question: str
    plan: PlanResult | None
    run: RunResult | None
    r: Retrieved


@dataclass
class _Prepared:
    part: PartView
    early: Presentation | None = None          # a reply from code: failed, clarify, cannot answer
    rows: list[dict[str, Any]] = field(default_factory=list)
    columns: list[OutputColumn] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _prepare(p: PartView) -> _Prepared:
    if (early := _reply_without_result(p.plan, p.run)) is not None:
        return _Prepared(p, early=early)
    assert p.plan is not None and p.plan.spec is not None and p.run is not None
    return _Prepared(p, rows=formatted_rows(p.run.rows, p.run.columns), columns=p.run.columns,
                     notes=[*_period_notes(p.plan.spec), *p.plan.assumptions, *p.run.warnings])


def _result_block(x: _Prepared, cat: Catalog, h: Names) -> str:
    assert x.part.plan is not None and x.part.run is not None
    meaning = rows_meaning(x.part.plan, h)
    return ((f"What the rows are: {meaning}\n\n" if meaning else "")
            + f"Result ({x.part.run.row_count} row(s)):\n{_table(x.rows[:PROMPT_ROWS], x.columns)}\n\n"
            "Columns:\n" + "\n".join(_legend(x.columns, cat, h)) + "\n\nNotes:\n"
            + ("\n".join(f"- {n}" for n in x.notes) or "-"))


def _answer_prompt(question: str, prepared: list[_Prepared], cat: Catalog, h: Names) -> str:
    if len(prepared) == 1:
        return f"Question: {question}\n\n" + _result_block(prepared[0], cat, h)
    blocks = []
    for x in prepared:
        head = f"## Part {x.part.id}: {x.part.question}\n"
        blocks.append(head + (f"No result: {x.early.answer_markdown}" if x.early else _result_block(x, cat, h)))
    return (f"Question: {question}\n\nIt was answered in {len(prepared)} parts; answer every part, in order, "
            "in one answer.\n\n" + "\n\n".join(blocks))


async def present(question: str, plan: PlanResult | None, run: RunResult | None, r: Retrieved, cat: Catalog,
                  h: Names, agents: PresentAgents, on_event: EventSink | None = None) -> Presentation:
    """One question, one result."""
    return await present_parts(question, [PartView("q1", question, plan, run, r)], cat, h, agents, on_event)


@timed("step 6: present")
async def present_parts(question: str, parts: list[PartView], cat: Catalog, h: Names, agents: PresentAgents,
                        on_event: EventSink | None = None) -> Presentation:
    """The answer to `question` from the results of its parts (one part: the usual answer). Charts and
    follow-ups are made per part; charts carry their part's id."""
    prepared = [_prepare(p) for p in parts]
    usable = [x for x in prepared if x.early is None]
    if not usable:
        if len(prepared) == 1:
            early = prepared[0].early
        else:
            text = "\n\n".join(f"**{x.part.question}**\n\n{x.early.answer_markdown}" for x in prepared if x.early)
            statuses = {x.early.status for x in prepared if x.early}
            early = Presentation(status=statuses.pop() if len(statuses) == 1 else "failed", answer_markdown=text)
        assert early is not None
        if on_event:
            await on_event("answer", {"answer_markdown": early.answer_markdown, "status": early.status})
        return early

    out = Presentation(status="answered" if any(x.rows for x in usable) else "empty", answer_markdown="",
                       warnings=[w for x in usable for w in (x.part.run.warnings if x.part.run else [])])
    charts: dict[str, list[dict[str, Any]]] = {}
    follow_ups: dict[str, list[dict[str, Any]]] = {}

    async def write() -> None:
        base = _answer_prompt(question, prepared, cat, h)
        allowed: set[float] = set()
        for x in usable:
            allowed |= numbers_allowed(f"{question} {x.part.question}", x.rows, x.notes,
                                       original_dataset(x.rows, x.columns, cat).additive)
        text = await agents.answer.run(base, on_event)
        invented = unknown_numbers(text, allowed)
        if invented:
            if on_event:
                await on_event("answer_reset", {"reason": f"numbers not in the result: {', '.join(invented)}"})
            text = await agents.answer.run(
                base + f"\n\nYour previous answer quoted numbers that are not in the result or notes: {', '.join(invented)}. "
                "Write it again quoting only numbers that appear above.", on_event)
            still = unknown_numbers(text, allowed)
            if still:
                out.notes.append(f"the answer quotes numbers not found in the result: {', '.join(still)}")
        out.answer_markdown = text
        out.trace.append({"agent": "answer", "text": text, "rewritten": bool(invented)})

    async def chart(x: _Prepared) -> None:
        rows, columns, q = x.rows, x.columns, x.part.question
        if len(rows) == 1:
            charts[x.part.id] = stat_cards(rows, columns, column_labels(columns, cat))
            return
        if len(rows) < 2 or not any(c.kind in ("metric", "derived") for c in columns):
            return
        original = original_dataset(rows, columns, cat)
        agent = agents.charts(original)
        tables = _tables_block(columns, cat)
        additive = ", ".join(sorted(original.additive)) or "none"
        prompt = (f"Question: {q}\n\n"
                  + ("Tables of the result (call things by these names, as described):\n"
                     + "\n".join(tables) + "\n\n" if tables else "")
                  + "Result columns (dataset original):\n" + "\n".join(_legend(columns, cat, h))
                  + f"\nMeasures that can be added up: {additive}"
                  + f"\n\n{len(rows)} rows; first rows:\n{_table(rows[:8], columns)}")
        run_ = await agent.run(prompt, on_event, question=q)
        out.trace.append({"agent": "chart", "part": x.part.id, "tool_calls": run_.tool_calls,
                          "answer": run_.result.model_dump()})
        datasets = chart_data.build(original, run_.result.datasets)
        made = []
        for p in run_.result.charts:
            ds = datasets.get(p.data)
            if ds is not None:
                made.append(with_labels({**chart_payload(p, ds.rows, ds.columns), "data": p.data}, ds.labels))
        if not made and (fallback := default_bar(rows, columns, q)):
            made = [fallback]
        if made and not any(c["recommended"] for c in made):
            made[0]["recommended"] = True
        charts[x.part.id] = made

    async def follow(x: _Prepared) -> None:
        assert x.part.plan is not None
        answer = await agents.follow_ups.run(follow_up_context(x.part.question, x.part.plan.spec, x.part.r, cat, h),
                                             on_event)
        kept, dropped = checked_follow_ups(x.part.question, answer.questions, h)
        out.trace.append({"agent": "follow_ups", "part": x.part.id, "answer": answer.model_dump(), "dropped": dropped})
        follow_ups[x.part.id] = kept

    jobs = [("answer", write()), *((f"charts {x.part.id}", chart(x)) for x in usable),
            *((f"follow-ups {x.part.id}", follow(x)) for x in usable)]
    results = await asyncio.gather(*(j for _, j in jobs), return_exceptions=True)
    for (name, _), res in zip(jobs, results, strict=True):
        if isinstance(res, AgentFailed):
            out.notes.append(f"{name} failed: {res}")
        elif isinstance(res, BaseException):
            raise res
    if not out.answer_markdown:
        out.answer_markdown = "\n\n".join(_table(x.rows[:PROMPT_ROWS], x.columns) for x in usable if x.rows) \
            or "Không có dữ liệu phù hợp."
    for x in usable:
        part_charts = [*charts.get(x.part.id, []), *([data_table(x.rows, x.columns)] if x.rows else [])]
        labels = column_labels(x.columns, cat)
        out.charts += [{**(c if "labels" in c else with_labels(c, labels)), "part": x.part.id} for c in part_charts]
    # follow-ups: take them in turn from each part (the first of each part first), without repeats
    queues = [list(follow_ups.get(x.part.id, [])) for x in usable]
    seen: set[str] = set()
    while len(out.follow_ups) < MAX_FOLLOW_UPS and any(queues):
        for q_ in queues:
            while q_ and len(out.follow_ups) < MAX_FOLLOW_UPS:
                f = q_.pop(0)
                key = " ".join(f["question"].lower().split())
                if key not in seen:
                    seen.add(key)
                    out.follow_ups.append(f)
                    break
    if on_event:
        await on_event("answer", {"answer_markdown": out.answer_markdown, "status": out.status})
        await on_event("charts", {"charts": out.charts})
        await on_event("follow_ups", {"questions": out.follow_ups})
    return out
