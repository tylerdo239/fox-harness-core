"""Step 3 picks: what the specialists (table picker, term matcher, value matcher) chose, and
`apply_selection`, which checks every pick against the catalog and turns them into a Retrieved
for step 4.
"""

from pydantic import BaseModel, Field

from src.pipeline_v4.agents.keywords import Keywords
from src.pipeline_v4.catalog import Catalog, row_count_id
from src.pipeline_v4.context import AgentContext, Names, UnknownName
from src.pipeline_v4.retrieve import (
    Retrieved,
    ValueMatch,
    _lookups,
    _metric_tables,
)
from src.pipeline_v4.timing import timed


class PickedTable(BaseModel):
    table: str = Field(description="table name, e.g. conversations")
    reason: str = Field(description="why the question needs it")


class PickedValue(BaseModel):
    phrase: str = Field(description="the words of the question")
    column: str = Field(description="column as table.column, e.g. branches.region")
    value: str = Field(description="the stored code, e.g. MN")


class NotFound(BaseModel):
    phrase: str
    reason: str


class RetrievalOut(BaseModel):
    tables: list[PickedTable] = Field(default_factory=list, description="tables needed, the measured or listed table first")
    metrics: list[str] = Field(default_factory=list, description="metric names that fit")
    terms: list[str] = Field(default_factory=list, description="business terms that fit")
    columns: list[str] = Field(default_factory=list, description="columns for groupings and conditions")
    values: list[PickedValue] = Field(default_factory=list, description="values the question names")
    not_found: list[NotFound] = Field(default_factory=list, description="phrases with nothing matching in the profile")


def agent_prompt(question: str, keywords: Keywords | None, pre: AgentContext) -> str:
    phrases = "\n".join(f"- {p.text} (english: {p.english}; role: {p.role})" for p in (keywords.phrases if keywords else []))
    times = ", ".join(keywords.time_phrases) if keywords and keywords.time_phrases else "none"
    return (f"Question: {question}\n\nKey phrases:\n{phrases or '- (none extracted: read the question)'}\n"
            f"Time phrases (handled later): {times}\n\n# Pre-search result\n{pre.text}")


@timed("check selection")
async def apply_selection(
    out: RetrievalOut, pre: Retrieved, cat: Catalog, h: Names
) -> Retrieved:
    """Turn the agent's picks into a Retrieved, keeping only what exists in the catalog. Tables of
    the chosen metrics, terms, columns and values are added when the agent forgot them."""
    r = Retrieved(question=pre.question, keywords=pre.keywords, notes=list(pre.notes))
    dropped: list[str] = []

    def resolve(name: str, kind: str) -> str | None:
        try:
            return h.resolve(name, kind)  # type: ignore[arg-type]
        except UnknownName:
            dropped.append(name)
            return None

    def add_table(tid: str | None) -> None:
        if tid and tid in cat.tables and tid not in r.tables:
            r.tables.append(tid)

    for t in out.tables:
        add_table(resolve(t.table, "table"))
    for m in out.metrics:
        mid = resolve(m, "metric")
        if mid and mid not in r.metrics:
            r.metrics.append(mid)
            for tid in sorted(_metric_tables(cat, mid)):
                add_table(tid)
            mdoc = cat.metrics[mid]
            if mdoc.get("kind") == "ratio":
                for side in ("numerator_metric_id", "denominator_metric_id"):
                    part = mdoc.get(side)
                    if part in cat.metrics and part not in r.metrics:
                        r.metrics.append(part)
    for g in out.terms:
        gid = resolve(g, "term")
        if gid and gid not in r.glossary:
            r.glossary.append(gid)
            add_table(cat.glossary[gid].get("entity_id"))
    for c in out.columns:
        cid = resolve(c, "column")
        if cid:
            r.columns[cid] = 1.0
            add_table(cat.columns[cid].entity_id)
    for v in out.values:
        cid = resolve(v.column, "column")
        if cid is None:
            continue
        items = cat.columns[cid].profile.value_catalog
        item = next((i for i in items if i.value == v.value), None)
        if item is None and items:
            # the agent may have copied the label instead of the code
            item = next(
                (
                    i
                    for i in items
                    if (i.label or "").strip().lower() == v.value.strip().lower()
                ),
                None,
            )
        if item is None and items and cat.columns[cid].profile.value_catalog_complete:
            dropped.append(f"{v.column}={v.value}")
            continue
        value = item.value if item else v.value
        r.values.append(
            ValueMatch(
                cid,
                value,
                item.label if item else None,
                v.phrase,
                exact=item is not None,
            )
        )
        add_table(cat.columns[cid].entity_id)

    # every metric of the chosen tables is an option for the measure picker: saved ones, then the
    # built-in row count of each table
    chosen = set(r.tables)
    for mid, m in sorted(cat.metrics.items(), key=lambda kv: kv[1].get("name") or ""):
        if not m.get("builtin") and mid not in r.metrics and _metric_tables(cat, mid) and _metric_tables(cat, mid) <= chosen:
            r.metrics.append(mid)
    for tid in r.tables:
        bid = row_count_id(tid)
        if bid in cat.metrics and bid not in r.metrics:
            r.metrics.append(bid)
    r.not_found = [(n.phrase, n.reason) for n in out.not_found]
    if dropped:
        r.notes.append("ignored unknown picks: " + ", ".join(dropped))
    if not r.tables:
        pre.notes.append("the retrieval agent picked no table; using the pre-search")
        return pre
    allowed = {tid: t for tid, t in cat.tables.items() if t.is_exposed and not t.is_pii}
    r.lookups = _lookups(r.tables, cat, allowed)
    r.scores = {tid: pre.scores.get(tid, 0.0) for tid in r.tables}
    return r
