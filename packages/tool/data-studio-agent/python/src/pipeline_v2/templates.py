"""SQL AST builders, one per JoinStrategy (design doc's templates).

All builders return a SQLGlot exp.Select so step 8 can hand the AST straight to v1's
validate_sql (which validates the AST without re-parsing — important because glossary
filter fragments embed Dremio-specific syntax SQLGlot can't round-trip from text).

Tables are referenced by bare physical name (last path segment), matching how ON clauses
name them, so column refs and the entity-scoped validation schema line up — same convention
as v1's sql_generation.
"""

from sqlglot import exp
from sqlmodel import Session

from src.database.models import Entity, EntityColumn
from src.pipeline_v2.state import (
    FilterSpec,
    JoinEdge,
    JoinStrategy,
    MetricSpec,
    PipelineState,
)


def build_sql_ast(session: Session, state: PipelineState) -> exp.Select:
    strategy = state.join_plan.strategy if state.join_plan else JoinStrategy.NONE
    if strategy in (JoinStrategy.NONE, JoinStrategy.DIRECT_OK):
        return _build_flat(session, state)
    if strategy == JoinStrategy.PRE_AGG:
        return _build_pre_agg(session, state)
    if strategy == JoinStrategy.SPLIT_CTE:
        return _build_split_cte(session, state)
    return _build_flat(session, state)


# ── helpers ──

def _table_name(session: Session, entity_id: int) -> str:
    entity = session.get(Entity, entity_id)
    return entity.physical_path.split(".")[-1] if entity else ""


def _table_path(session: Session, entity_id: int) -> str:
    entity = session.get(Entity, entity_id)
    return entity.physical_path if entity else ""


def _col(session: Session, column_id: int) -> exp.Column:
    c = session.get(EntityColumn, column_id)
    if c is None:
        raise ValueError(f"unknown column_id={column_id}")
    return exp.column(c.physical_name, table=_table_name(session, c.entity_id))


def _col_physical(session: Session, column_id: int) -> str:
    c = session.get(EntityColumn, column_id)
    return c.physical_name if c else ""


def _metric_expr(session: Session, m: MetricSpec) -> exp.Expression:
    if m.expr_column_id is None:
        return exp.Count(this=exp.Star()).as_(m.alias)
    col = _col(session, m.expr_column_id)
    agg = m.agg.lower()
    if agg == "count_distinct":
        return exp.Count(this=exp.Distinct(expressions=[col])).as_(m.alias)
    func = {"count": "COUNT", "sum": "SUM", "avg": "AVG", "min": "MIN", "max": "MAX"}.get(agg, "COUNT")
    return exp.func(func, col).as_(m.alias)


def _filter_conditions(session: Session, state: PipelineState) -> list[exp.Expression]:
    conds: list[exp.Expression] = []
    # business-rule (glossary) filters embedded verbatim as opaque fragments — trusted, curated
    for rule in state.business_rules:
        conds.append(exp.paren(exp.Var(this=rule.filter_sql)))
    for f in state.filters:
        conds.append(_plain_filter(session, f))
    for cond_sql in state.edge_cases.soft_delete_conditions:
        conds.append(exp.Var(this=cond_sql))
    if state.time is not None:
        conds.extend(_time_conditions(session, state))
    return conds


def _plain_filter(session: Session, f: FilterSpec) -> exp.Expression:
    col = _col(session, f.column_id)
    op = f.operator.strip().lower()
    val = exp.Literal.string(f.value) if f.value is not None else exp.Null()
    ops = {
        "=": exp.EQ, "!=": exp.NEQ, "<>": exp.NEQ, ">": exp.GT,
        ">=": exp.GTE, "<": exp.LT, "<=": exp.LTE,
    }
    if op in ops:
        return ops[op](this=col, expression=val)
    if op == "like":
        return exp.Like(this=col, expression=val)
    if op == "in":
        vals = [exp.Literal.string(v.strip()) for v in (f.value or "").split(",")]
        return exp.In(this=col, expressions=vals)
    return exp.EQ(this=col, expression=val)


def _time_conditions(session: Session, state: PipelineState) -> list[exp.Expression]:
    t = state.time
    col = _col(session, t.column_id)
    conds = []
    if t.start:
        conds.append(exp.GTE(this=col, expression=exp.Literal.string(t.start)))
    if t.end:
        conds.append(exp.LT(this=col, expression=exp.Literal.string(t.end)))  # half-open
    return conds


def _apply_where(select_expr: exp.Select, conds: list[exp.Expression]) -> exp.Select:
    for c in conds:
        select_expr = select_expr.where(c)
    return select_expr


def _soft_delete_for_table(state: PipelineState, table_name: str) -> list[str]:
    """Soft-delete condition strings that reference the given table only. Needed for CTE
    strategies: a branch table lives inside its CTE, so its soft-delete filter must go INSIDE
    that CTE, not in the outer WHERE (where the table isn't in scope → 'table not found')."""
    prefix = f"{table_name}."
    return [c for c in state.edge_cases.soft_delete_conditions if c.startswith(prefix)]


def _apply_order_limit(select_expr: exp.Select, state: PipelineState) -> exp.Select:
    if state.edge_cases.order_by:
        select_expr = select_expr.order_by(state.edge_cases.order_by)
    if state.edge_cases.limit is not None:
        select_expr = select_expr.limit(state.edge_cases.limit)
    return select_expr


# ── strategy: none / direct_ok — single flat SELECT with joins ──

def _build_flat(session: Session, state: PipelineState) -> exp.Select:
    grain_id = state.grain_entity_id
    select_items: list[exp.Expression] = []
    for cid in state.select_column_ids:
        c = session.get(EntityColumn, cid)
        select_items.append(_col(session, cid).as_(c.physical_name))
    for m in state.metrics:
        select_items.append(_metric_expr(session, m))

    q = exp.select(*select_items).from_(_table_path(session, grain_id))
    q = _apply_joins(session, q, state)
    q = _apply_where(q, _filter_conditions(session, state))

    if state.metrics:
        # SQL requires every non-aggregated SELECT column in GROUP BY. Union the declared
        # group_by columns with the plain (non-metric) select columns so a selected label
        # like workflows.name doesn't break the aggregate — same contract as v1's
        # _effective_group_by.
        group_ids = list(dict.fromkeys([*state.group_by_column_ids, *state.select_column_ids]))
        group_cols = [_col(session, cid) for cid in group_ids]
        if group_cols:
            q = q.group_by(*group_cols)

    return _apply_order_limit(q, state)


def _apply_joins(session: Session, q: exp.Select, state: PipelineState) -> exp.Select:
    if not state.join_plan:
        return q
    for e in state.join_plan.edges:
        to_path = _table_path(session, e.to_entity_id)
        from_table = _table_name(session, e.from_entity_id)
        to_table = _table_name(session, e.to_entity_id)
        on = exp.EQ(
            this=exp.column(e.from_column_physical, table=from_table),
            expression=exp.column(e.to_column_physical, table=to_table),
        )
        q = q.join(to_path, on=on, join_type="inner")
    return q


# ── strategy: pre_agg — aggregate expanding branch in a CTE, LEFT JOIN back ──

def _build_pre_agg(session: Session, state: PipelineState) -> exp.Select:
    """pre_agg fires when the METRIC lives on the grain/parent (one-side) but a 1:N child would
    duplicate that parent value across child rows. Fix: collapse the child to one row per parent
    in a subquery (a child COUNT), join that back, and keep the parent's own measure on the OUTER
    query where it aggregates cleanly at grain — never duplicated. The parent measure must NOT go
    inside the child subquery (the parent table isn't in scope there)."""
    grain_id = state.grain_entity_id
    grain_table = _table_name(session, grain_id)
    branch_id = state.join_plan.expanding_branch_entity_ids[0]
    edge = next(e for e in state.join_plan.edges if e.to_entity_id == branch_id)

    # inner: one row per parent — COUNT the child so the join can't fan out the parent measure
    fk_col = exp.column(edge.to_column_physical, table=_table_name(session, branch_id))
    child_count_alias = f"{_table_name(session, branch_id)}_count"
    inner = (
        exp.select(fk_col.as_("parent_key"), exp.Count(this=exp.Star()).as_(child_count_alias))
        .from_(_table_path(session, branch_id))
        .group_by(fk_col)
    )
    for rule in state.business_rules:
        if rule.applies_to_entity_id == branch_id:
            inner = inner.where(exp.paren(exp.Var(this=rule.filter_sql)))
    for cond in _soft_delete_for_table(state, _table_name(session, branch_id)):
        inner = inner.where(exp.Var(this=cond))

    subq = exp.Subquery(this=inner, alias=exp.TableAlias(this=exp.to_identifier("agg")))

    # outer: parent dimensions + the parent's OWN metric (aggregates at grain, not duplicated)
    #        + the pre-aggregated child count
    select_items: list[exp.Expression] = []
    for cid in state.select_column_ids:
        c = session.get(EntityColumn, cid)
        select_items.append(_col(session, cid).as_(c.physical_name))
    for m in state.metrics:
        select_items.append(_metric_expr(session, m))
    select_items.append(exp.column(child_count_alias, table="agg").as_(child_count_alias))

    on = exp.EQ(
        this=exp.column("parent_key", table="agg"),
        expression=exp.column(edge.from_column_physical, table=grain_table),
    )
    q = (
        exp.select(*select_items)
        .from_(_table_path(session, grain_id))
        .join(subq, on=on, join_type="left")
    )
    outer_conds = [exp.Var(this=c) for c in _soft_delete_for_table(state, grain_table)]
    q = _apply_where(q, outer_conds)
    # the parent metric aggregates, so group by the parent dimensions + the child count
    if state.metrics:
        group_ids = list(dict.fromkeys([*state.group_by_column_ids, *state.select_column_ids]))
        group_cols = [_col(session, cid) for cid in group_ids]
        group_cols.append(exp.column(child_count_alias, table="agg"))
        q = q.group_by(*group_cols)
    return _apply_order_limit(q, state)


# ── strategy: split_cte — one CTE per parallel branch, LEFT JOIN all back ──

def _build_split_cte(session: Session, state: PipelineState) -> exp.Select:
    grain_id = state.grain_entity_id
    grain_table = _table_name(session, grain_id)
    grain_id_col = None
    if state.dimensions:
        grain_id_col = _col_physical(session, state.dimensions[0].id_column_id)

    select_items: list[exp.Expression] = []
    for cid in state.select_column_ids:
        c = session.get(EntityColumn, cid)
        select_items.append(_col(session, cid).as_(c.physical_name))

    q = exp.select(*select_items).from_(_table_path(session, grain_id))

    ctes: list[tuple[str, exp.Select]] = []
    for i, branch_id in enumerate(state.join_plan.expanding_branch_entity_ids):
        edge = next(e for e in state.join_plan.edges if e.to_entity_id == branch_id)
        alias = f"branch_{i}"
        fk_col = exp.column(edge.to_column_physical, table=_table_name(session, branch_id))
        count_alias = f"count_{i}"
        inner = (
            exp.select(fk_col.as_("parent_key"), exp.Count(this=exp.Star()).as_(count_alias))
            .from_(_table_path(session, branch_id))
            .group_by(fk_col)
        )
        for rule in state.business_rules:
            if rule.applies_to_entity_id == branch_id:
                inner = inner.where(exp.paren(exp.Var(this=rule.filter_sql)))
        # branch table's own soft-delete belongs INSIDE the CTE, where the table is in scope
        for cond in _soft_delete_for_table(state, _table_name(session, branch_id)):
            inner = inner.where(exp.Var(this=cond))
        ctes.append((alias, inner))

        on = exp.EQ(
            this=exp.column("parent_key", table=alias),
            expression=exp.column(edge.from_column_physical, table=grain_table),
        )
        q = q.join(exp.to_identifier(alias), on=on, join_type="left")
        q = q.select(exp.func("COALESCE", exp.column(count_alias, table=alias), exp.Literal.number(0)).as_(count_alias))

    for alias, inner in ctes:
        q = q.with_(alias, as_=inner)

    # only the grain table is in the outer FROM, so only its soft-delete goes in the outer WHERE
    outer_conds = [exp.Var(this=c) for c in _soft_delete_for_table(state, grain_table)]
    q = _apply_where(q, outer_conds)
    return _apply_order_limit(q, state)
