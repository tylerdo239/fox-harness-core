"""Step 4: question + found profile → QuerySpec → compiled SQL, with small specialist agents.

  1. intent router         question type (total, grouped, top N, trend, compare periods, list rows,
                           rows with/without related rows, per-then-summarize), N, time grain
  2. specialists           only those the question needs, in parallel, each deciding one thing:
                           measure (metrics), time (date ranges), grouping (columns), condition
                           (filters, segments), set ("more than N related rows"), per (per column,
                           summaries)
  3. build_parts (code)    the router's intent + the specialists' answers → MetricOut / DimensionOut /
                           FilterOut: ranking, growth, row-list shape and columns, time grouping,
                           set keys, names next to ids, period keys
  4. assemble + compile    names → ids → QuerySpec → SQL; each error goes back to the specialist (or
                           the router) that owns it, ≤ MAX_FIX_ROUNDS, starting from its previous answer

The measure picker may answer clarify or cannot_answer; that stops the step.
"""

import asyncio
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ValidationError

from src.pipeline_v4.agents.base import (
    AgentFailed,
    EventSink,
    StructuredAgent,
    ToolAgent,
)
from src.pipeline_v4.agents.keywords import Keywords
from src.pipeline_v4.agents.parts import (
    ConditionOut,
    DerivedPick,
    DimensionOut,
    DimensionPick,
    FilterOut,
    GrainOut,
    GroupOut,
    GroupPick,
    IntentOut,
    KindOut,
    MeasureOut,
    MetricOut,
    MetricPick,
    PeriodPick,
    PerOut,
    PerPick,
    RankOut,
    RankPick,
    RelatedOut,
    RowsOut,
    SetConditionPick,
    SetFilterPick,
    SetOut,
    SetPick,
    SummaryPick,
    TimeOut,
)
from src.pipeline_v4.agents.specialists import (
    condition_agent,
    grain_reader,
    grouping_agent,
    kind_router,
    measure_picker,
    per_agent,
    rank_reader,
    related_agent,
    rows_reader,
    set_agent,
    time_agent,
)
from src.pipeline_v4.catalog import Catalog, row_count_id
from src.pipeline_v4.compiler import Compiled, CompileError, SpecError, compile_spec
from src.pipeline_v4.context import AgentContext, Names, UnknownName
from src.pipeline_v4.retrieve import Retrieved, Searcher, words
from src.pipeline_v4.spec import QuerySpec
from src.pipeline_v4.timing import timed
from src.pipeline_v4.tools.common import TIME_TYPES
from src.settings import Settings

MAX_FIX_ROUNDS = 2
Agent = Literal["router", "measure", "time", "grouping", "condition", "related", "set", "per"]

# QuerySpec field → who fills it (specialist, or the router for what code builds from its intent)
_FIELD_OWNER: dict[str, Agent] = {
    "metrics": "measure", "periods": "time", "detail_period": "time", "dimensions": "grouping",
    "filters": "condition", "segments": "condition", "summaries": "per", "per": "per",
    "shape": "router", "entity_id": "router", "derived": "router", "rank": "router", "limit": "router",
    "columns": "router", "order_by": "router", "buckets": "router", "set_filters": "router",
    "include_default_filters": "router", "having": "router",
}


def owner_agent(err: SpecError) -> Agent:
    """Who must fix a compiler error: by the spec field first, then by the error's owner."""
    head = err.field.split(".")[0].split("[")[0]
    if head == "related":
        return "related"
    if err.field.startswith("per.metrics") or err.field.startswith("per.column"):
        return "measure" if "metrics" in err.field else "per"
    if head == "sets":
        return "set" if ".having" in err.field or ".metric" in err.field else "condition" if ".filters" in err.field else "router"
    if head in _FIELD_OWNER:
        return _FIELD_OWNER[head]
    return {"metric": "measure", "dimension": "grouping", "filter": "condition", "period": "time",
            "rank": "router", "detail": "router"}.get(err.owner, "router")  # type: ignore[return-value]


@dataclass
class PlanAgents:
    router: StructuredAgent[KindOut]
    rank: StructuredAgent[RankOut]
    grain: StructuredAgent[GrainOut]
    rows: StructuredAgent[RowsOut]
    measure: ToolAgent[MeasureOut]
    time: ToolAgent[TimeOut]
    grouping: ToolAgent[GroupOut]
    condition: ToolAgent[ConditionOut]
    set: ToolAgent[SetOut]
    per: ToolAgent[PerOut]
    related: ToolAgent[RelatedOut]


def make_plan_agents(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
                     scope: list[str] | None = None) -> PlanAgents:
    return PlanAgents(router=kind_router(settings), rank=rank_reader(settings), grain=grain_reader(settings),
                      rows=rows_reader(settings), measure=measure_picker(settings, h), time=time_agent(settings),
                      grouping=grouping_agent(settings, cat, h, searcher, scope),
                      condition=condition_agent(settings, cat, h, searcher, scope), set=set_agent(settings, h),
                      per=per_agent(settings, cat, h, searcher, scope), related=related_agent(settings, cat, h, searcher, scope))


@dataclass
class PlanResult:
    status: Literal["ok", "clarify", "cannot_answer", "failed"]
    spec: QuerySpec | None = None
    compiled: Compiled | None = None
    message: str | None = None
    options: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    errors: list[SpecError] = field(default_factory=list)
    intent: IntentOut | None = None
    answers: dict[str, BaseModel] = field(default_factory=dict)
    rounds: int = 0
    trace: list[dict[str, Any]] = field(default_factory=list)


def business_today(cat: Catalog, table_ids: list[str]) -> date:
    """Today in the business time zone of the first found table that has one (UTC otherwise)."""
    for tid in table_ids:
        tz = cat.tables[tid].profile.business_tz if tid in cat.tables else None
        if tz:
            try:
                return datetime.now(ZoneInfo(tz)).date()
            except ZoneInfoNotFoundError:
                continue
    return datetime.now(UTC).date()


# ── assemble ──

class _Resolver:
    def __init__(self, h: Names, cat: Catalog) -> None:
        self.h, self.cat = h, cat
        self.errors: list[SpecError] = []

    def __call__(self, name: str | None, kind: str, owner: Any, fld: str) -> str | None:
        if name is None or not str(name).strip():
            return None
        try:
            return self.h.resolve(str(name), kind)  # type: ignore[arg-type]
        except UnknownName as err:
            self.errors.append(SpecError(owner=owner, field=fld, message=f"{err.name!r} is not a known {err.kind}",
                                         suggestions=err.suggestions))
            return None


@timed("assemble spec")
async def assemble(m: MetricOut, d: DimensionOut, f: FilterOut, h: Names, cat: Catalog) -> tuple[QuerySpec | None, list[SpecError]]:
    r = _Resolver(h, cat)

    def mref(x: Any, fld: str) -> dict[str, Any]:
        return {"name": x.name, "metric_id": r(x.metric, "metric", "metric", fld) or "", "period": x.period}

    def fpick(x: Any, fld: str) -> dict[str, Any]:
        return {"column_id": r(x.column, "column", "filter", fld) or "", "op": x.op, "values": x.values,
                "reason": x.reason}

    raw: dict[str, Any] = {
        "shape": m.shape,
        "entity_id": r(m.table, "table", "metric", "entity_id"),
        "metrics": [mref(x, f"metrics[{i}]") for i, x in enumerate(m.metrics)],
        "derived": [x.model_dump() for x in m.derived],
        "per": None if m.per is None else {
            "column_id": r(m.per.column, "column", "metric", "per.column_id") or "",
            "metrics": [mref(x, f"per.metrics[{i}]") for i, x in enumerate(m.per.metrics)],
            "include_zero": m.per.include_zero},
        "summaries": [x.model_dump() for x in m.summaries],
        "having": [x.model_dump() for x in m.having],
        "rank": None if m.rank is None else {
            **m.rank.model_dump(),
            "partition_by": [r(c, "column", "dimension", f"rank.partition_by[{i}]") or "" for i, c in enumerate(d.partition_by)]},
        "limit": m.limit,
        "dimensions": [{"column_id": r(x.column, "column", "dimension", f"dimensions[{i}]") or "",
                        "time_grain": x.time_grain} for i, x in enumerate(d.dimensions)],
        "buckets": d.buckets.model_dump() if d.buckets else None,
        "columns": [r(c, "column", "dimension", f"columns[{i}]") or "" for i, c in enumerate(d.columns)],
        "order_by": [x.model_dump() for x in d.order_by],
        "filters": [fpick(x, f"filters[{i}]") for i, x in enumerate(f.filters)],
        "segments": [r(g, "term", "filter", f"segments[{i}]") or "" for i, g in enumerate(f.segments)],
        "periods": {p.key: {"start": p.start, "end": p.end, "label": p.label} for p in f.periods},
        "sets": {s.name: {
            "key_column_id": r(s.key_column, "column", "filter", f"sets.{s.name}.key_column") or "",
            "metric_id": r(s.metric, "metric", "filter", f"sets.{s.name}.metric"),
            "having": [x.model_dump() for x in s.having],
            "filters": [fpick(x, f"sets.{s.name}.filters[{i}]") for i, x in enumerate(s.filters)],
            "segments": [r(g, "term", "filter", f"sets.{s.name}.segments[{i}]") or ""
                         for i, g in enumerate(s.segments)],
            "period": s.period} for s in f.sets},
        "set_filters": [{"column_id": r(x.column, "column", "filter", f"set_filters[{i}]") or "",
                         "op": x.op, "set": x.set} for i, x in enumerate(f.set_filters)],
        "include_default_filters": f.include_default_filters,
        "detail_period": f.detail_period,
    }
    if r.errors:
        return None, r.errors
    try:
        return QuerySpec.model_validate(raw), []
    except ValidationError as err:
        out = []
        for e in err.errors():
            loc = ".".join(str(x) for x in e.get("loc", ()))
            out.append(SpecError(owner="spec", field=loc or "spec", message=str(e.get("msg"))))
        return None, out


# ── which specialists run ──

def needed(intent: IntentOut, keywords: Keywords | None, r: Retrieved, cat: Catalog | None = None,
           h: Names | None = None) -> list[Agent]:
    kind = intent.kind
    roles = {p.role for p in keywords.phrases} if keywords else set()
    out: list[Agent] = []
    if kind not in ("list_rows", "rows_with", "rows_without"):  # those list or count rows: no measure to pick
        out.append("measure")
    out.append("time")  # always: a period missed by the keyword step would otherwise widen the query to all dates
    if kind in ("grouped", "top_n") or (kind in ("trend", "compare_periods", "per_summary") and "group" in roles):
        out.append("grouping")
    # always: a condition missed by the keyword step ("tỉnh <X>" not picked up) would otherwise be dropped
    # without a trace; the agent adds nothing when there is none, and a filter must quote the question
    out.append("condition")
    if kind in ("rows_with", "rows_without"):
        out.append("set")
    if kind == "per_summary":
        out.append("per")
    if cat is not None and h is not None and _names_other_table(intent, keywords, r, cat, h):
        out.append("related")
    return out


def _table_words(cat: Catalog, tid: str) -> set[str]:
    t = cat.tables[tid]
    return {w for x in [t.physical_name, t.display_name, *t.synonyms] for w in words(x.replace("_", " "))}


def _names_other_table(intent: IntentOut, keywords: Keywords | None, r: Retrieved, cat: Catalog, h: Names) -> bool:
    """A phrase (not a grouping) names a found table other than the counted / listed / related one:
    'conversation với workflows' names workflows. The related agent decides if it limits the rows."""
    if keywords is None or not r.tables:
        return False
    own = {r.tables[0]}
    if intent.kind in ("list_rows", "rows_with", "rows_without"):
        own |= {t for t in (_table_of(intent.listed_table, h, r, 0), _table_of(intent.related_table, h, r, 1)) if t}
    said = {w for p in keywords.phrases if p.role != "group" for w in words(p.text)}
    said -= {w for t in own for w in _table_words(cat, t)}  # "order" names orders, not order_items
    return any(said & _table_words(cat, t) for t in r.all_tables if t not in own)


# ── code templates: intent + answers → spec parts ──

def _one_row_groups(column: str, metric_names: list[str], h: Names, cat: Catalog) -> str | None:
    """Counting a table's rows split by that table's own key gives 1 in every group: the split
    must be the thing the question ranks or groups (top 5 workflows → workflows.workflow_id)."""
    try:
        cid = h.resolve(column, "column")
    except UnknownName:
        return None
    table = cat.columns[cid].entity_id
    if cat.tables[table].profile.grain_key_column_ids != [cid]:
        return None
    for name in metric_names:
        try:
            metric = cat.metrics[h.resolve(name, "metric")]
        except UnknownName:
            continue
        if metric.get("entity_id") == table and metric.get("aggregation") in ("count", "count_distinct"):
            return (f"splitting by {column} makes one group per row of {h.of(table)}, so every {name} is 1; "
                    f"split by the column of the thing the question ranks or groups (e.g. the id of what "
                    f"'top N …' names), not by the counted rows' own key")
    return None


def _per_candidates(table: str, h: Names, cat: Catalog, not_like: str | None = None) -> list[str]:
    """Columns that identify the rows of `table`: its key, and the columns of other tables that link to it
    (without those that identify the same thing as the column `not_like`)."""
    keys = list(cat.tables[table].profile.grain_key_column_ids)
    linked = [a if b in keys else b for j in cat.joins for a, b in j.pairs if (a in keys) != (b in keys)]
    out = [h.of(c) for c in dict.fromkeys([*keys, *linked]) if c in h.name_of]
    if not_like is not None:
        same = _identifying(h.of(not_like), h, cat)
        out = [c for c in out if c != h.of(not_like) and _identifying(c, h, cat) != same]
    return out


def _categories(table: str, h: Names, cat: Catalog) -> list[str]:
    """Columns of `table` that sort its rows into a few kinds (a type, a status, a flag)."""
    keys = set(cat.tables[table].profile.grain_key_column_ids)
    return [h.of(c.id) for c in cat.columns_of(table)
            if c.id in h.name_of and c.id not in keys and c.role != "key" and c.data_type not in TIME_TYPES
            and (c.semantic_type in ("category", "boolean") or c.profile.value_catalog)]


def _per_problem(per_column: str, groupings: list[str], h: Names, cat: Catalog) -> tuple[str, bool] | None:
    """A per column that cannot work with the grouping: (message, also send it to the grouping agent).

    - it is a grouping column itself: each group has one per value. Code can't tell which of the two is
      wrong, so both agents get it, with what each could pick instead
    - a grouping column is the key of a table and the per column another column of that table: each
      <table> row has one per value, so every summary is that one value (per and grouping swapped)"""
    try:
        pid = h.resolve(_identifying(per_column, h, cat), "column")
        gids = [h.resolve(g, "column") for g in groupings]
    except UnknownName:
        return None
    for gid in gids:
        table = cat.columns[gid].entity_id
        if gid == pid:
            finer = _per_candidates(table, h, cat, not_like=gid)
            kinds = [c for c in _categories(table, h, cat) if c != h.of(gid)]
            return (f"{h.of(gid)} is both the grouping and the per column, so each group holds a single value. "
                    "The grouping is the category the result is split by; the per column identifies the things "
                    "counted inside each group. When the question says 'each kind / type of <X>', the grouping "
                    "is a category column of <X>'s table"
                    + (f" ({', '.join(kinds)})" if kinds else "")
                    + f" and the per column identifies each <X> ({h.of(gid)})"
                    + (f"; otherwise the per column is something finer inside each group ({', '.join(finer)})"
                       if finer else "")
                    + ". Keep the one that matches your part of the question and change only if yours is wrong"), True
        keys = cat.tables[table].profile.grain_key_column_ids
        if keys == [gid] and cat.columns[pid].entity_id == table and pid not in keys:
            options = ", ".join(_per_candidates(table, h, cat)) or "the key column of the things summarized"
            return (f"grouping by {h.of(gid)} makes one group per row of {h.of(table)}, and each of them has "
                    f"one {h.of(pid)}: every summary would be that single value. The grouping is the category "
                    f"the result is split by ({h.of(pid)}?) and the per column identifies the things inside it "
                    f"({options})"), True
    return None


def _merged_splits(picks: list[GroupPick], splits: list[str]) -> str | None:
    """One grouping whose phrase covers two or more splits of the question ('by <X> of each <Y>') while
    fewer groupings than splits were added: the result would be split by one of them only."""
    if len(picks) >= len(splits):
        return None
    for g in picks:
        have = set(words(g.phrase))
        covered = [s for s in splits if words(s) and set(words(s)) <= have]
        if len(covered) >= 2:
            listed = ", ".join(repr(c) for c in covered)
            return (f"the grouping {g.column} uses the phrase {g.phrase!r}, which names {len(covered)} splits "
                    f"({listed}); the result must be split by each of them. add_grouping once per split, each "
                    "with its own words as the phrase, and keep this one only for the split it names")
    return None


def _identifying(column: str, h: Names, cat: Catalog) -> str:
    """A column that points at another table's key (conversations.agent_id → agents.agent_id) is
    replaced by that key, so the other table's name column is shown next to it."""
    try:
        cid = h.resolve(column, "column")
    except UnknownName:
        return column  # assemble reports it to the owner
    col = cat.columns[cid]
    own = cat.tables[col.entity_id].profile
    if cid in own.grain_key_column_ids and own.label_column_id:
        return column
    for j in cat.joins:
        for a, b in j.pairs:
            other = b if a == cid else a if b == cid else None
            if other is None or other not in h.name_of:
                continue
            target = cat.tables[cat.columns[other].entity_id].profile
            if other in target.grain_key_column_ids and target.label_column_id:
                return h.of(other)
    return column


def _detail_columns(table_id: str, h: Names, cat: Catalog) -> list[str]:
    """Columns of a row list: the row's name, its keys and its main time."""
    p = cat.tables[table_id].profile
    ids = [p.label_column_id, *p.grain_key_column_ids, p.time_column_id]
    out = []
    for cid in ids:
        if cid and cid in h.name_of and h.of(cid) not in out:
            out.append(h.of(cid))
    return out or [h.of(c.id) for c in h.columns_of(table_id)[:5]]


def _table_of(name: str | None, h: Names, r: Retrieved, fallback: int) -> str | None:
    if name:
        try:
            tid = h.resolve(name, "table")
            if tid in r.all_tables:
                return tid
        except UnknownName:
            pass
    return r.tables[fallback] if len(r.tables) > fallback else None


def _table_of_column(column: str, h: Names, cat: Catalog) -> str | None:
    try:
        return cat.columns[h.resolve(column, "column")].entity_id
    except UnknownName:
        return None


def _metric_table(metric_names: list[str], h: Names, cat: Catalog) -> str | None:
    for name in metric_names:
        try:
            return cat.metrics[h.resolve(name, "metric")].get("entity_id")
        except UnknownName:
            continue
    return None


def _link(listed: str, related: str, cat: Catalog) -> tuple[str, str] | None:
    """(column of the listed table, column of the related table) of a relationship between them."""
    for j in cat.joins:
        if {j.from_entity_id, j.to_entity_id} == {listed, related} and j.pairs:
            a, b = j.pairs[0]
            return (a, b) if cat.columns[a].entity_id == listed else (b, a)
    return None


def build_parts(intent: IntentOut, ans: dict[str, BaseModel], r: Retrieved, cat: Catalog,
                h: Names) -> tuple[MetricOut, DimensionOut, FilterOut, list[SpecError]]:
    m, d, f = MetricOut(), DimensionOut(), FilterOut()
    errors: list[SpecError] = []

    def err(owner: str, fld: str, message: str) -> None:
        errors.append(SpecError(owner=owner, field=fld, message=message))  # type: ignore[arg-type]

    kind = intent.kind
    measure = ans.get("measure")
    metric_names: list[str] = list(measure.metrics) if isinstance(measure, MeasureOut) else []
    time = ans.get("time")
    ranges = list(time.periods) if isinstance(time, TimeOut) else []

    # periods: one range "p", or "cur" + "prev" for a comparison
    if kind == "compare_periods":
        if len(ranges) != 2:
            err("period", "periods", "a comparison needs exactly two time ranges: the current one first, then the one compared with")
        keys = ["cur", "prev"]
    else:
        if len(ranges) > 1:
            err("period", "periods", "give one time range (the one the question asks about), or none")
        keys = ["p"]
    f.periods = [PeriodPick(key=k, start=p.start, end=p.end, label=p.label) for k, p in zip(keys, ranges, strict=False)]
    pkey = "p" if ranges and kind != "compare_periods" else None

    # conditions (filters on the related table of a set go into the set)
    cond = ans.get("condition")
    filters = list(cond.filters) if isinstance(cond, ConditionOut) else []
    f.segments = list(cond.segments) if isinstance(cond, ConditionOut) else []

    if kind in ("total", "grouped", "top_n", "trend", "compare_periods") and not metric_names:
        err("metric", "metrics", "pick the metric that measures what the question asks")
    used: set[str] = set()

    def result_name(base: str) -> str:
        name, i = base, 2
        while name in used:
            name, i = f"{base}_{i}", i + 1
        used.add(name)
        return name

    if kind in ("total", "grouped", "top_n", "trend"):
        m.metrics = [MetricPick(name=result_name(n), metric=n, period=pkey) for n in metric_names]
    elif kind == "compare_periods":
        for n in metric_names:
            cur, prev = result_name(f"{n}_cur"), result_name(f"{n}_prev")
            m.metrics += [MetricPick(name=cur, metric=n, period="cur"), MetricPick(name=prev, metric=n, period="prev")]
            m.derived.append(DerivedPick(name=result_name(f"{n}_growth_pct"), op="growth", args=[cur, prev], scale=100))

    if kind == "top_n":
        if not intent.top_n:
            err("rank", "rank", "top_n needs N (how many)")
        elif m.metrics:
            m.rank = RankPick(by=m.metrics[0].name, top=intent.top_n, direction=intent.direction)

    if kind == "trend" and metric_names:
        try:
            mid = h.resolve(metric_names[0], "metric")
        except UnknownName:
            mid = None
        tid = cat.metrics[mid].get("entity_id") if mid else None
        time_col = (cat.metrics[mid].get("time_column_id") or cat.tables[tid].profile.time_column_id) if mid and tid in cat.tables else None
        if time_col and time_col in h.name_of:
            d.dimensions.append(DimensionPick(column=h.of(time_col), time_grain=intent.time_grain or "month"))
        else:
            err("rank", "dimensions", f"{metric_names[0]} has no time column to follow over time")

    group = ans.get("grouping")
    picks = list(group.columns) if isinstance(group, GroupOut) else []
    cols = [_identifying(g.column, h, cat) for g in picks]
    within: list[str] = []
    if kind == "top_n" and intent.within and picks:
        # the rank reader read "top N inside each <within>"; the grouping whose phrase names it is the partition
        want = set(words(intent.within))
        within = list(dict.fromkeys(c for g, c in zip(picks, cols, strict=True) if want & set(words(g.phrase))))
        if not within:
            err("dimension", "dimensions", f"the top N is taken inside each {intent.within!r}: add_grouping for it, "
                "with those words in the phrase")
        elif set(cols) <= set(within):
            err("dimension", "dimensions", f"the top N is taken inside each {intent.within!r}: also add_grouping "
                "the thing that is ranked")
            within = []
        d.partition_by = within
    # the partition first, so rows come group by group
    d.dimensions += [DimensionPick(column=c) for c in dict.fromkeys([*within, *cols])]
    for g in picks:
        if (problem := _one_row_groups(g.column, metric_names, h, cat)):
            err("dimension", "dimensions", problem)
    if (problem := _merged_splits(picks, other_groupings(r.keywords))):
        err("dimension", "dimensions", problem)
    if kind in ("grouped", "top_n") and not picks:
        err("dimension", "dimensions", "pick the column the result is split by")

    if kind == "list_rows":
        listed = _table_of(intent.listed_table, h, r, 0)
        if listed is None:
            err("detail", "entity_id", "no table to list")
        else:
            m.shape, m.table = "detail", h.of(listed)
            d.columns = _detail_columns(listed, h, cat)
            f.detail_period = pkey

    if kind in ("rows_with", "rows_without"):
        listed = _table_of(intent.listed_table, h, r, 0)
        related = _table_of(intent.related_table, h, r, 1)
        link = _link(listed, related, cat) if listed and related and listed != related else None
        if link is None:
            err("detail", "set_filters", "say which table's rows are listed and which related table they must (not) have rows in")
        else:
            own_col, rel_col = link
            st = ans.get("set")
            conds = list(st.conditions) if isinstance(st, SetOut) else []
            set_filters = [x for x in filters if x.column in h.name_of.values()
                           and cat.columns[h.resolve(x.column, "column")].entity_id == related]
            filters = [x for x in filters if x not in set_filters]
            f.sets = [SetPick(name="related", key_column=h.of(rel_col), metric=conds[0].metric if conds else None,
                              having=[SetConditionPick(op=c.op, value=c.value) for c in conds],
                              filters=set_filters, period=pkey)]
            f.set_filters = [SetFilterPick(column=h.of(own_col), op="in_set" if kind == "rows_with" else "not_in_set",
                                           set="related")]
            if intent.count_rows:
                count = row_count_id(listed)
                m.metrics = [MetricPick(name=result_name(f"count_{cat.tables[listed].physical_name}"),
                                        metric=h.of(count))] if count in cat.metrics else []
            else:
                m.shape, m.table = "detail", h.of(listed)
                d.columns = _detail_columns(listed, h, cat)

    if kind == "per_summary":
        per = ans.get("per")
        if not isinstance(per, PerOut) or not per.column:
            err("dimension", "per.column_id", "say what the measure is computed per")
        elif (found := _per_problem(per.column, cols, h, cat)) is not None:
            problem, grouping_too = found
            err("dimension", "per.column_id", problem)
            if grouping_too:
                err("dimension", "dimensions", problem)
        elif metric_names:
            base = metric_names[0]
            m.per = PerPick(column=per.column, metrics=[MetricPick(name=base, metric=base, period=pkey)],
                            include_zero=per.include_zero)
            m.summaries = [SummaryPick(name=result_name(f"{a}_{base}" if a != "count" else "count"), agg=a,
                                       of=None if a == "count" else base) for a in (per.summaries or ["avg"])]

    rel_out = ans.get("related")
    related = list(rel_out.related) if isinstance(rel_out, RelatedOut) else []
    if related:
        main = _table_of(intent.listed_table, h, r, 0) if kind in ("list_rows", "rows_with", "rows_without") \
            else _metric_table(metric_names, h, cat)
        # tables already in the query: the counted / listed one, the related one of a row list, the ones
        # the result is split by. "Has a related row" in one of those changes nothing: left out.
        in_query = {t for t in (main, _table_of(intent.related_table, h, r, 1) if kind in ("rows_with", "rows_without")
                                else None) if t}
        in_query |= {_table_of_column(c, h, cat) for c in cols} - {None}
        for i, rel in enumerate(related):
            try:
                rid = h.resolve(rel.table, "table")
            except UnknownName:
                err("filter", f"related[{i}]", f"{rel.table!r} is not a known table")
                continue
            if rid in in_query:
                continue
            link = _link(main, rid, cat) if main else None
            if link is None:
                where = h.of(main) if main else "the counted table"
                err("filter", f"related[{i}]", f"{h.of(rid)} has no direct relationship with {where}, so "
                    "'has related rows' can't be checked; pick the related table that is linked to it")
                continue
            own_col, rel_col = link
            name = "has_" + re.sub(r"\W+", "_", h.of(rid)).lower()
            f.sets.append(SetPick(name=name, key_column=h.of(rel_col)))
            f.set_filters.append(SetFilterPick(column=h.of(own_col), op="in_set" if rel.has else "not_in_set", set=name))

    f.filters = filters
    if isinstance(measure, MeasureOut):
        m.assumptions = list(measure.assumptions)
    return m, d, f, errors


# ── prompts ──

_KIND_TEXT = {
    "total": "one total number", "grouped": "numbers split by a category", "top_n": "the top N groups",
    "trend": "numbers over time", "compare_periods": "a comparison of two time ranges",
    "list_rows": "a list of rows", "rows_with": "rows that have related rows",
    "rows_without": "rows that have no related rows", "per_summary": "a summary of values computed per something",
}


def base_prompt(question: str, keywords: Keywords | None, ctx: AgentContext, today: date) -> str:
    times = ", ".join(keywords.time_phrases) if keywords and keywords.time_phrases else "none"
    return (f"Question: {question}\nToday: {today.isoformat()} ({today.strftime('%A')})\n"
            f"Time phrases found in the question (may miss one): {times}\n\n# Data profile for this question\n{ctx.text}")


def router_prompt(question: str, keywords: Keywords | None, r: Retrieved, h: Names, cat: Catalog) -> str:
    tables = "\n".join(f"- {h.of(t)}: one row = {cat.tables[t].grain_description or cat.tables[t].display_name}"
                       for t in r.all_tables)
    phrases = ", ".join(f"{p.text} ({p.role})" for p in keywords.phrases) if keywords else "-"
    times = ", ".join(keywords.time_phrases) if keywords and keywords.time_phrases else "none"
    return (f"Question: {question}\nKey phrases: {phrases}\nTime phrases: {times}\n\n"
            f"Tables found for it:\n{tables}")


TIME_STEPS = {"day", "daily", "week", "weekly", "month", "monthly", "quarter", "quarterly", "year", "yearly", "annual"}


def time_groupings(keywords: Keywords | None) -> list[str]:
    """The question's phrases that split the result by time steps ('by month'), as the keyword reader
    marked them (role group, English naming a time step)."""
    if keywords is None:
        return []
    return [p.text for p in keywords.phrases
            if p.role == "group" and TIME_STEPS & set(p.english.lower().replace("-", " ").split())]


def other_groupings(keywords: Keywords | None) -> list[str]:
    """The question's phrases that split the result by something other than time."""
    if keywords is None:
        return []
    timed_ = set(time_groupings(keywords))
    return [p.text for p in keywords.phrases if p.role == "group" and p.text not in timed_]


def check_intent(intent: IntentOut, keywords: Keywords | None) -> list[SpecError]:
    """Readings that can't fit the question go back to the router."""
    errors = []
    if intent.kind in ("total", "grouped") and (steps := time_groupings(keywords)):
        others = other_groupings(keywords)
        errors.append(SpecError(owner="rank", field="kind", message=(
            f"the question splits the numbers by time ({', '.join(repr(t) for t in steps)}), so the kind is trend"
            + (f"; its other split ({', '.join(repr(o) for o in others)}) is added as a grouping of the trend"
               if others else ""))))
    if intent.kind == "compare_periods" and not (keywords and keywords.time_phrases):
        errors.append(SpecError(owner="rank", field="kind", message="the question names no time range, so it is not "
                                "a comparison of periods; pick another kind"))
    if intent.kind in ("rows_with", "rows_without") and intent.listed_table and intent.related_table and \
            intent.listed_table.strip().lower() == intent.related_table.strip().lower():
        errors.append(SpecError(owner="rank", field="kind", message="the listed table and the related table are the same"))
    return errors


# how each specialist changes its answer: errors from the compiler name spec fields, the agent knows its tools
_FIX_WITH: dict[str, str] = {
    "measure": "add_metric(phrase, metric) for the right metric; remove(part='metrics', item=<metric>) for a wrong one",
    "time": "add_period(phrase, start, end, label) for the right range; remove(part='periods', item=<start>) for a wrong one",
    "grouping": "add_grouping(phrase, column) for the right column; remove(part='columns', item=<column>) for a "
                "wrong one",
    "condition": "add_filter(...) / add_segment(...) for the right condition; remove(part='filters', item=<column>) "
                 "or remove(part='segments', item=<term>) for a wrong one",
    "set": "add_condition(...) for the right condition; remove(part='conditions', item=<metric>) for a wrong one",
    "related": "add_has_related(phrase, table, has) for the right table; remove(part='related', item=<table>) for a "
               "wrong one",
    "per": "set_per(phrase, column) to change the per column (it replaces the current one); add_summary(agg) or "
           "remove(part='summaries', item=<agg>) for the summaries",
}


def specialist_prompt(base: str, intent: IntentOut, errors: list[SpecError], again: bool, agent: str = "",
                      repeated: frozenset[str] = frozenset()) -> str:
    """The specialist's prompt; with `errors`, what was rejected and how to fix it with its tools
    (`repeated`: messages already sent last round, which its fix did not solve)."""
    parts = [base, f"# Question type: {_KIND_TEXT[intent.kind]}"
             + (f" (top {intent.top_n})" if intent.kind == "top_n" and intent.top_n else "")]
    if errors:
        problems = "\n".join(f"- {e.message}" + (f" (try: {', '.join(e.suggestions)})" if e.suggestions else "")
                             + (" [reported last round too: your change did not fix it, choose differently]"
                                if e.message in repeated else "")
                             for e in errors)
        how = f"\nNext: {_FIX_WITH[agent]}, then call done." if agent in _FIX_WITH else ""
        parts.append("# Your current answer (below) was rejected for these reasons. Fix them with the edit tools "
                     f"(change only what is wrong), then reply done:\n{problems}{how}")
    elif again:
        parts.append("# Check that your current answer (below) still fits; change only what does not, then reply done.")
    return "\n\n".join(parts)


# ── checks ──

def check_metric_tables(spec: QuerySpec, cat: Catalog, names: Names, tables: list[str]) -> list[SpecError]:
    """A metric must count rows of a table the question is about (found in step 3); a metric of an
    unrelated table compiles fine but answers another question."""
    allowed = set(tables)
    errors = []
    refs = [(f"metrics[{i}]", r) for i, r in enumerate(spec.metrics)]
    if spec.per:
        refs += [(f"per.metrics[{i}]", r) for i, r in enumerate(spec.per.metrics)]
    for fld, ref in refs:
        m = cat.metrics.get(ref.metric_id) or {}
        parts = [m] if m.get("kind") != "ratio" else [cat.metrics.get(m.get(s) or "") or {}
                                                      for s in ("numerator_metric_id", "denominator_metric_id")]
        for part in parts:
            tid = part.get("entity_id")
            if tid and tid not in allowed:
                wanted = ", ".join(names.of(t) for t in tables)
                counts = ", ".join(names.of(row_count_id(t)) for t in tables if row_count_id(t) in cat.metrics)
                errors.append(SpecError(
                    owner="metric", field=fld,
                    message=f"{m.get('name')} is computed from {names.of(tid)}, but this question is about {wanted}; "
                            f"pick a metric of those tables" + (f" (row counts: {counts})" if counts else ""),
                ))
    return errors


# ── flow ──

@timed("step 4: plan")
async def plan_query(question: str, keywords: Keywords | None, ctx: AgentContext, r: Retrieved, cat: Catalog,
                     agents: PlanAgents, today: date, on_event: EventSink | None = None) -> PlanResult:
    h = ctx.names
    base = base_prompt(question, keywords, ctx, today)
    trace: list[dict[str, Any]] = []
    answers: dict[str, BaseModel] = {}

    async def route(errors: list[SpecError]) -> IntentOut:
        """Kind first; then only the readers that kind needs, in parallel; code checks the result."""
        prompt = router_prompt(question, keywords, r, h, cat)
        for _ in range(MAX_FIX_ROUNDS + 1):
            ask_prompt = prompt + ("\n\nThe previous reading led to these problems:\n"
                                   + "\n".join(f"- {e.message}" for e in errors) if errors else "")
            kind = (await agents.router.run(ask_prompt, on_event)).kind
            jobs: dict[str, Any] = {}
            if kind == "top_n":
                jobs["rank"] = agents.rank.run(ask_prompt, on_event)
            if kind == "trend":
                jobs["grain"] = agents.grain.run(ask_prompt, on_event)
            if kind in ("list_rows", "rows_with", "rows_without"):
                jobs["rows"] = agents.rows.run(ask_prompt, on_event)
            got = dict(zip(jobs, await asyncio.gather(*jobs.values()), strict=True))
            intent = IntentOut(kind=kind)
            if "rank" in got:
                intent.top_n, intent.direction = got["rank"].top_n, got["rank"].direction
                intent.within = (got["rank"].within or "").strip() or None
            if "grain" in got:
                intent.time_grain = got["grain"].time_grain
            if "rows" in got:
                intent.listed_table = got["rows"].listed_table
                intent.related_table = got["rows"].related_table or None
                intent.count_rows = got["rows"].count_rows
            trace.append({"agent": "router", "answer": intent.model_dump(), "fixing": [e.model_dump() for e in errors]})
            if on_event:
                await on_event("intent", intent.model_dump())
            errors = check_intent(intent, keywords)
            if not errors:
                return intent
        return intent

    sent: dict[str, frozenset[str]] = {}   # agent → error messages it got last round

    async def ask(name: Agent, intent: IntentOut, rnd: int, errors: list[SpecError]) -> None:
        previous = answers.get(name)
        repeated = sent.get(name, frozenset())
        sent[name] = frozenset(e.message for e in errors)
        run = await getattr(agents, name).run(specialist_prompt(base, intent, errors, previous is not None, name, repeated),
                                              on_event, initial=previous, question=question)
        trace.append({"agent": name, "round": rnd, "text": run.text, "tool_calls": run.tool_calls,
                      "answer": run.result.model_dump(), "fixing": [e.model_dump() for e in errors]})
        answers[name] = run.result

    def stop() -> PlanResult | None:
        mo = answers.get("measure")
        if isinstance(mo, MeasureOut) and mo.status != "ok":
            return PlanResult(status=mo.status, message=mo.message or "no metric fits", options=list(mo.options),
                              assumptions=list(mo.assumptions))
        return None

    try:
        intent = await route([])
        ran = needed(intent, keywords, r, cat, h)
        await asyncio.gather(*(ask(n, intent, 0, []) for n in ran))
        if (s := stop()) is not None:
            return _finish(s, intent, answers, trace, 0)
        errors: list[SpecError] = []
        for rnd in range(MAX_FIX_ROUNDS + 1):
            m, d, f, errors = build_parts(intent, answers, r, cat, h)
            if not errors:
                spec, errors = await assemble(m, d, f, h, cat)
                if spec is not None:
                    errors = check_metric_tables(spec, cat, h, r.all_tables)
                if spec is not None and not errors:
                    try:
                        compiled = await compile_spec(spec, cat)
                        assumptions = [*m.assumptions, *compiled.assumptions]
                        return _finish(PlanResult(status="ok", spec=spec, compiled=compiled,
                                                  assumptions=list(dict.fromkeys(assumptions))),
                                       intent, answers, trace, rnd)
                    except CompileError as e:
                        errors = e.errors
            if rnd == MAX_FIX_ROUNDS:
                break
            if on_event:
                await on_event("spec_errors", {"round": rnd, "errors": [e.model_dump() for e in errors]})
            by_agent: dict[str, list[SpecError]] = {}
            for e in errors:
                by_agent.setdefault(owner_agent(e), []).append(e)
            if "router" in by_agent:
                intent = await route(by_agent.pop("router"))
                for n in needed(intent, keywords, r, cat, h):
                    by_agent.setdefault(n, [])  # new specialists the new intent needs (or a re-check)
            await asyncio.gather(*(ask(n, intent, rnd + 1, errs) for n, errs in by_agent.items()))  # type: ignore[arg-type]
            if (s := stop()) is not None:
                return _finish(s, intent, answers, trace, rnd + 1)
        return _finish(PlanResult(status="failed", errors=errors,
                                  message="the question could not be turned into a valid query"),
                       intent, answers, trace, MAX_FIX_ROUNDS)
    except AgentFailed as e:
        return _finish(PlanResult(status="failed", message=str(e)), None, answers, trace, 0)


def _finish(result: PlanResult, intent: IntentOut | None, answers: dict[str, BaseModel],
            trace: list[dict[str, Any]], rounds: int) -> PlanResult:
    result.intent, result.answers, result.trace, result.rounds = intent, dict(answers), trace, rounds
    return result
