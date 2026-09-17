"""Step 4 — Metrics + dimensions + select list (single LLM call + rule).

The model decides, in one call, what is aggregated (metrics) and what the results are grouped
by (dimensions). Keeping metric-and-grouping in ONE call matters: they're interdependent — a
'top 5 workflows by node count' needs the metric (count) and the dimension (workflow) chosen
together, and splitting them made the model mis-pick the metric without the grouping context.
Code then resolves each dimension into an id column (GROUP BY / JOIN key) and a label column
(SELECT), and assembles the final select list via the priority ladder so the answer never
comes back as a bare id with no human-readable label.

Role → clause mapping (from curated ColumnRole):
  dimension → SELECT + GROUP BY   measure → SELECT (wrapped in aggregate)
  key       → JOIN ON only        (only surfaced in SELECT if the user asked for the id)
"""

from pydantic import BaseModel, Field
from sqlmodel import Session

from sqlmodel import select

from src.database.models import EntityColumn, EntityRelationship
from src.database.models.enums import Cardinality, ColumnRole
from src.pipeline_v2 import derive
from src.pipeline_v2.state import DimensionSpec, MetricSpec, PipelineState
from src.services.llm_client import LLMClient

_INSTRUCTIONS = """\
# Role
You plan **WHAT to aggregate** and **WHAT to group by**. Do NOT write SQL.

# Metrics — the thing being measured/counted
- For "how many intent nodes per workflow", the metric is a count of nodes.
- Use `count_rows = true` for a plain `COUNT(*)`; otherwise set `agg` + `measure_column_id`
  (a **measure-role** column only).
- **Listing has no metric:** if the request only LISTS or SHOWS rows (e.g. "list the agents",
  "which workflows exist") and computes no number, leave metrics **EMPTY** — do not invent a count.

# Dimensions — what each result row is broken down by (the grain entity)
- For "top 5 workflows by X", the dimension is the **workflow** entity.
- For a "per Y" / "each Y" question, **Y** is the dimension.
- For a single overall total, leave dimensions **empty**.
- **Ranking / superlative rule:** when the question RANKS or asks for a superlative of one entity
  by a measure of ANOTHER (the answer names a single/few of entity **A** that lead by some
  count/aggregate of entity **B**), entity **A** is a dimension — a ranking compares A's to each
  other, so it must GROUP BY A. Leaving dimensions empty here collapses every A into one total and
  the ranking is lost. The ranked entity is the dimension **even when the wording does not
  literally say "per A"**.
- **Never group by the entity you are counting.** When the metric counts occurrences of entity B
  to measure entity A (e.g. "which A is used most, measured by how many B", "top A by number of
  B"), B is the MEASURE, not a group. Make B only the count target and do NOT add B as a dimension
  — the sole dimension is A (the grain). Adding B as a dimension makes each group one (A, B) pair,
  so every count becomes 1 and the ranking is destroyed. A phrase like "theo từng B" / "per B"
  attached to a "most-used A" question describes WHAT is counted (each B is one use of A), not an
  extra grouping level.

# Display columns
- Put in `output_column_ids` the columns that should appear in the result, chosen to ANSWER the
  question well — not every column, and not none. For a LISTING ("list the workflows of ..."),
  pick the few meaningful, human-readable columns: a name/label, and the id only if it identifies
  the row; include an attribute the question asks about (status, date, ...). Do NOT dump every
  column of the table, and do NOT include raw internal/technical columns (deleted_at, raw config
  blobs) unless the question is about them.
- If the user explicitly named columns ("kèm email", "with created date"), always include those.
- For an aggregate/ranking answer, the dimension label + metric are added automatically — only
  add extra display columns here when the question asks to also SEE a specific attribute.

# Constraints
- Only reference `column_id`s from the candidates provided. **Never invent ids.**
"""


class MetricOut(BaseModel):
    agg: str | None = Field(default=None, description="count | count_distinct | sum | avg | min | max")
    measure_column_id: int | None = Field(default=None, description="measure column to aggregate, if any")
    count_rows: bool = Field(default=False, description="true for a plain COUNT(*)")
    alias: str = Field(description="name for the metric, e.g. intent_node_count")


class DimensionOut(BaseModel):
    entity_id: int = Field(description="entity this dimension groups by")


class SelectPlan(BaseModel):
    metrics: list[MetricOut] = Field(default_factory=list)
    dimensions: list[DimensionOut] = Field(default_factory=list)
    output_column_ids: list[int] = Field(
        default_factory=list,
        description="column_ids to display in the result — meaningful readable columns that "
        "answer the question (a name/label, an asked-about attribute, id only if it identifies "
        "the row). Not every column, not raw technical ones. Empty is fine for a pure aggregate."
    )


def _render(session: Session, state: PipelineState) -> str:
    lines = [f"Intent: {state.intent or state.question}", f"Grain: {state.grain}", "", "Candidate columns:"]
    for eid in state.target_entity_ids or set(state.entity_ids()):
        for c in derive.exposed_columns(session, eid):
            role = c.role.value if c.role else "?"
            lines.append(f"[column_id={c.id}] {c.display_name} (entity={eid}, role={role})")
    if state.business_rules:
        lines.append("\nBusiness rules already resolved (their filters are applied separately):")
        for r in state.business_rules:
            lines.append(f"- {r.term}")
    return "\n".join(lines)


async def run_step4(session: Session, llm_client: LLMClient, state: PipelineState) -> None:
    plan = await llm_client.run_structured(
        _render(session, state), output_schema=SelectPlan, instructions=_INSTRUCTIONS
    )

    _apply_metrics(state, plan)
    _apply_dimensions(session, state, plan)
    _drop_grain_self_grouping(state)
    dropped_entities = _drop_measured_entity_grouping(session, state)
    _grain_sanity_check(session, state)
    _build_select_list(session, state, plan, dropped_entities)
    import logging as _lg
    _lg.getLogger(__name__).warning("STEP4-DONE grain=%s dims=%s metrics=%s select=%s group=%s over=%s",
        state.grain_entity_id, [d.entity_id for d in state.dimensions],
        [(m.agg, m.expr_column_id) for m in state.metrics], state.select_column_ids,
        state.group_by_column_ids, dropped_entities)


def _drop_grain_self_grouping(state: PipelineState) -> None:
    """Guard against a common weak-model misread: 'how many workflows' (a plain COUNT(*) of the
    grain entity) gets a dimension that IS the grain entity — grouping by the very thing being
    counted, so COUNT(*) becomes one-row-per-workflow (all 1s) instead of a single total.

    Critically, this only applies when the query touches a SINGLE entity. When another entity is
    joined in (e.g. 'top 5 workflows by conversation count' joins workflows→conversations), a
    plain COUNT(*) grouped by the workflow counts the JOINED many-side rows per workflow — the
    dimension is legitimate and must be kept. Dropping it there collapses a real per-workflow
    ranking into one meaningless grand total (the bug this guard must not cause).

    So: drop the self-grouping dimension only for a single-entity plain count. A multi-entity
    query keeps it (it's 'count the other entity per grain', not 'count the grain itself')."""
    single_entity = len(set(state.target_entity_ids)) <= 1
    only_plain_count = (
        len(state.metrics) == 1
        and state.metrics[0].expr_column_id is None
        and state.metrics[0].scoped_by_term is None
    )
    only_grain_dim = (
        len(state.dimensions) == 1
        and state.dimensions[0].entity_id == state.grain_entity_id
    )
    if single_entity and only_plain_count and only_grain_dim:
        state.dimensions = []
        state.group_by_column_ids = []
        state.add_assumption(
            "Interpreted as a single total count of the whole table, not a per-row breakdown."
        )


def _measured_entity_ids(session: Session, state: PipelineState) -> set[int]:
    """Entities that a metric AGGREGATES a column from (COUNT(col)/SUM(col)/…). A plain COUNT(*)
    metric has no measure entity."""
    ids: set[int] = set()
    for m in state.metrics:
        if m.expr_column_id is not None:
            col = session.get(EntityColumn, m.expr_column_id)
            if col is not None:
                ids.add(col.entity_id)
    return ids


def _child_entity_ids_of_grain(session: Session, state: PipelineState) -> set[int]:
    """Entities that are a 1:N (or N:N) child of the grain — the 'many' side reachable from the
    grain. A plain COUNT(*) 'per grain' counts THESE rows, so they must not also be a GROUP BY."""
    grain = state.grain_entity_id
    if grain is None:
        return set()
    children: set[int] = set()
    rels = session.exec(
        select(EntityRelationship).where(
            (EntityRelationship.from_entity_id == grain)
            | (EntityRelationship.to_entity_id == grain)
        )
    ).all()
    for r in rels:
        if r.cardinality == Cardinality.ONE_TO_MANY:
            # canonical from(1) -> to(N): the N side is the child only when grain is the 1 side
            if r.from_entity_id == grain:
                children.add(r.to_entity_id)
        elif r.cardinality == Cardinality.MANY_TO_MANY:
            other = r.to_entity_id if r.from_entity_id == grain else r.from_entity_id
            children.add(other)
    return children


def _drop_measured_entity_grouping(session: Session, state: PipelineState) -> set[int]:
    """Guard: the entity whose rows a metric counts must not ALSO be a GROUP BY dimension.

    'số workflow của mỗi agent' → grain=agents. The weak model tags `workflows` as a dimension, so
    the query groups by (agent, workflow_name) and counts ~1 workflow per pair instead of
    workflows-per-agent. We count workflows; we do not group by them.

    Two ways an over-grouping shows up:
      1. A metric aggregates a column ON that entity — COUNT(workflows.workflow_id) → measured set.
      2. A plain COUNT(*) counts a 1:N CHILD of the grain — the child is implicit in the join, not a
         grouping (this is the common weak-model shape, where the metric carries no measure column).

    In both cases, drop the dimension if it's a non-grain measured/child entity. Grouping by the
    grain itself stays (that's the 'per agent' part). A time-bucket or an unrelated dimension is
    neither measured nor a grain-child, so it's kept."""
    over_grouped = _measured_entity_ids(session, state)
    # a grain-child is also over-grouping when the query COUNTs (its rows are what's counted). This
    # covers both COUNT(*) and COUNT(child.col): in both the child is the thing counted, not a
    # grouping level. (A SUM/AVG of a real numeric column on the child is a different intent and is
    # left alone — only count-shaped metrics trigger the child rule.)
    if any(m.agg.lower().startswith("count") for m in state.metrics):
        over_grouped |= _child_entity_ids_of_grain(session, state)
    # never treat the grain itself as over-grouping — 'per grain' is the whole point
    over_grouped.discard(state.grain_entity_id)
    if not over_grouped:
        return set()

    # 1. drop any DimensionSpec on an over-grouped entity
    kept_dims = [d for d in state.dimensions if d.entity_id not in over_grouped]
    dropped_dim_ids = {d.id_column_id for d in state.dimensions if d.entity_id in over_grouped}
    if dropped_dim_ids:
        state.dimensions = kept_dims
        state.group_by_column_ids = [g for g in state.group_by_column_ids if g not in dropped_dim_ids]
        state.add_assumption(
            "Counted the sub-entity per grain, not grouped by it (dropped a spurious grouping on "
            "the entity being counted)."
        )
    # 2. return the over-grouped entity set so _build_select_list also strips SELECT columns on
    #    those entities — a selected column is unioned into GROUP BY downstream, which would
    #    re-introduce the grouping even when no DimensionSpec exists (the common leak: the model
    #    adds the counted entity's name as a *display* column, not a dimension).
    return over_grouped


def _grain_sanity_check(session: Session, state: PipelineState) -> None:
    """Cheap consistency check at the end of step 4: the grain entity should be represented in the
    GROUP BY when the query is a grouped aggregate. If there's a metric + at least one dimension but
    the grain entity is NOT among the grouping dimensions, the result is 'per <something-else>', not
    'per <grain>' — flag it as an assumption so the mismatch is visible rather than silent.

    We only note it (not hard-fix) because a legitimate query can group by a child of the grain;
    the note surfaces the ambiguity for the insight layer + the user."""
    if not state.metrics or not state.dimensions or state.grain_entity_id is None:
        return
    grain_in_group = any(d.entity_id == state.grain_entity_id for d in state.dimensions)
    if not grain_in_group:
        dim_entities = ", ".join(str(d.entity_id) for d in state.dimensions)
        state.add_assumption(
            f"Grain is entity {state.grain_entity_id} but the result groups by entity(ies) "
            f"{dim_entities}; the breakdown may not be per the intended subject."
        )


def _apply_metrics(state: PipelineState, plan: SelectPlan) -> None:
    for m in plan.metrics:
        if m.count_rows or (m.agg or "").lower() == "count" and m.measure_column_id is None:
            state.metrics.append(MetricSpec(agg="count", expr_column_id=None, alias=m.alias or "row_count"))
        elif m.agg and m.measure_column_id is not None:
            state.metrics.append(
                MetricSpec(agg=m.agg.lower(), expr_column_id=m.measure_column_id, alias=m.alias)
            )
    # scope each metric by a business rule if exactly one rule applies (e.g. 'intent node' count)
    if len(state.business_rules) == 1 and state.metrics:
        rule = state.business_rules[0]
        for metric in state.metrics:
            metric.scoped_by_term = rule.term


def _apply_dimensions(session: Session, state: PipelineState, plan: SelectPlan) -> None:
    valid_ids = set(state.target_entity_ids or set(state.entity_ids()))
    for d in plan.dimensions:
        if d.entity_id not in valid_ids:
            continue
        ident = derive.identifier_column(session, d.entity_id)
        label = derive.display_name_column(session, d.entity_id)
        if ident is None or ident.id is None:
            continue
        state.dimensions.append(
            DimensionSpec(
                entity_id=d.entity_id,
                id_column_id=ident.id,
                label_column_id=label.id if label else None,
            )
        )
        state.group_by_column_ids.append(ident.id)
        state.target_entity_ids.add(d.entity_id)


def _forced_select_columns(session: Session, state: PipelineState) -> list[int]:
    """Column ids flagged is_default_select on any entity the query touches — always selected."""
    entity_ids = list(state.target_entity_ids or set(state.entity_ids()))
    if not entity_ids:
        return []
    from sqlmodel import select as _sel
    cols = session.exec(
        _sel(EntityColumn).where(
            EntityColumn.entity_id.in_(entity_ids),
            EntityColumn.is_default_select == True,  # noqa: E712
            EntityColumn.is_exposed == True,  # noqa: E712
            EntityColumn.is_deprecated == False,  # noqa: E712
        )
    ).all()
    return [c.id for c in cols if c.id is not None]


def _build_select_list(
    session: Session, state: PipelineState, plan: SelectPlan, dropped_entities: set[int] | None = None
) -> None:
    """Priority ladder (higher tiers win, lower tiers only fill gaps):
    1. user-named columns  2. dimension label columns  3. table default label
    Metrics are always appended (they're the point of the query). Never emit a bare id.

    `dropped_entities` are entities whose grouping was removed by _drop_measured_entity_grouping;
    their columns must NOT re-enter the SELECT (a selected column is unioned into GROUP BY
    downstream, which would re-introduce the very grouping we just dropped)."""
    dropped_entities = dropped_entities or set()

    def _entity_of(cid: int) -> int | None:
        c = session.get(EntityColumn, cid)
        return c.entity_id if c else None

    select_ids: list[int] = []

    # tier 1 — the LLM-chosen display columns (excluding any on a dropped-grouping entity)
    for cid in plan.output_column_ids:
        if _entity_of(cid) in dropped_entities:
            continue
        if cid not in select_ids:
            select_ids.append(cid)

    # tier 2 — each dimension's human-readable label (fall back to its id if no label)
    for dim in state.dimensions:
        label = dim.label_column_id or dim.id_column_id
        if label not in select_ids:
            select_ids.append(label)

    # A plain aggregate — a metric with NO dimension and no explicitly-requested column — is a
    # single total ('how many workflows'). It must select ONLY the metric: adding a label here
    # would be unioned into GROUP BY downstream and silently turn one total into a per-row count.
    # So tier-3 default-label backfill applies only to a bare listing (no metric) or a grouped
    # query (has dimensions), never to a plain total.
    plain_total = bool(state.metrics) and not state.dimensions
    if plain_total:
        # No dimension → no grouping. Drop any label columns entirely (even model-"requested"
        # ones) so the query stays a single total row; the metric is appended in SQL build.
        state.select_column_ids = []
        return

    # curator override: columns flagged is_default_select are ALWAYS added for any query touching
    # their entity, regardless of what the planning LLM picked (the model tends to omit some
    # columns the user always wants). Skipped for a plain total above, where extra columns would
    # break the aggregate; here (listing or grouped) they're safe and become part of GROUP BY.
    for cid in _forced_select_columns(session, state):
        if cid not in select_ids:
            select_ids.append(cid)

    # tier 3 — if still nothing readable, use the grain entity's default label columns
    if not select_ids and state.grain_entity_id is not None:
        for cid in derive.default_select_columns(session, state.grain_entity_id):
            if cid not in select_ids:
                select_ids.append(cid)

    # safety: ensure a label exists so we never return an unlabeled result
    if not select_ids and state.grain_entity_id is not None:
        ident = derive.identifier_column(session, state.grain_entity_id)
        if ident and ident.id:
            select_ids.append(ident.id)

    state.select_column_ids = select_ids
