import sqlglot
from sqlglot import exp
from sqlmodel import Session, select

import re

from src.database.models import Entity, EntityColumn
from src.database.models.enums import DefaultAggregation, JoinType
from src.services.join_path import JoinPlan, render_from_clause
from src.services.plan import InnerAggregation, QueryPlan

_AGG_FUNC_MAP = {
    DefaultAggregation.SUM: "SUM",
    DefaultAggregation.AVG: "AVG",
    DefaultAggregation.COUNT: "COUNT",
    DefaultAggregation.COUNT_DISTINCT: "COUNT",
    DefaultAggregation.MIN: "MIN",
    DefaultAggregation.MAX: "MAX",
}

_OPERATOR_MAP = {
    "=": lambda col, val: exp.EQ(this=col, expression=val),
    "!=": lambda col, val: exp.NEQ(this=col, expression=val),
    "<>": lambda col, val: exp.NEQ(this=col, expression=val),
    ">": lambda col, val: exp.GT(this=col, expression=val),
    ">=": lambda col, val: exp.GTE(this=col, expression=val),
    "<": lambda col, val: exp.LT(this=col, expression=val),
    "<=": lambda col, val: exp.LTE(this=col, expression=val),
    "like": lambda col, val: exp.Like(this=col, expression=val),
}


class SQLGenerationError(Exception):
    pass


class InnerAggregationColumnError(SQLGenerationError):
    """Raised when inner_aggregation references a column outside its own entity — this means
    schema_linking didn't select the right entity's own column (e.g. picked a same-named
    column from a different, joined entity instead), so retrying the plan step alone can't
    fix it. Routed back to schema_linking instead of plan."""


def generate_sql_ast(session: Session, join_plan: JoinPlan, query_plan: QueryPlan) -> exp.Select:
    """Pure code — no LLM. The join skeleton from Step 5 is never touched; this only
    fills in SELECT/WHERE/GROUP BY, resolving every identifier against the real catalog.
    Returns the AST (not a string) so Step 7 can validate it directly without re-parsing —
    some filters embed opaque Dremio-specific raw SQL (see _build_filter_condition) that
    SQLGlot's parser cannot round-trip from text, even though it's valid and runs on Dremio."""
    if query_plan.inner_aggregation is not None:
        return _generate_distribution_sql_ast(session, query_plan.inner_aggregation)

    columns_by_id = _load_columns(session, _all_referenced_column_ids(query_plan))

    from_clause_sql = render_from_clause(join_plan)
    skeleton = sqlglot.parse_one(f"SELECT 1 {from_clause_sql}")
    if not isinstance(skeleton, exp.Select):
        raise SQLGenerationError("Failed to build a valid SELECT skeleton from the join plan")

    select_expressions = _build_select_expressions(columns_by_id, query_plan)
    skeleton.set("expressions", select_expressions)

    for f in query_plan.filters:
        skeleton = skeleton.where(_build_filter_condition(columns_by_id, f))

    effective_group_by = _effective_group_by(query_plan)
    if effective_group_by:
        group_cols = [_column_ref(columns_by_id, cid) for cid in effective_group_by]
        skeleton = skeleton.group_by(*group_cols)

        left_joined_entities = _left_joined_entity_ids(join_plan)
        for cid in effective_group_by:
            _, entity = columns_by_id[cid]
            if entity.id in left_joined_entities:
                skeleton = skeleton.where(
                    exp.Not(this=exp.Is(this=_column_ref(columns_by_id, cid), expression=exp.Null()))
                )

    order_expr = _build_order_expression(columns_by_id, query_plan)
    if order_expr is not None:
        skeleton = skeleton.order_by(order_expr)

    if query_plan.limit is not None:
        skeleton = skeleton.limit(query_plan.limit)

    return skeleton


_VALID_ALIAS = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _generate_distribution_sql_ast(session: Session, inner: InnerAggregation) -> exp.Select:
    """Builds a two-level 'distribution of a count' query, e.g. 'how many conversations
    collected how many variables': inner query counts Y per X, outer query counts how many
    X's landed in each Y-count bucket. No join_plan needed — always a single entity, since
    the inner group_by/count and outer bucket-count both operate on the same table."""
    if not _VALID_ALIAS.match(inner.alias):
        raise SQLGenerationError(f"Invalid inner_aggregation.alias: {inner.alias!r}")

    columns_by_id = _load_columns(session, [inner.group_by_column_id, inner.count_column_id])
    group_col = _column_ref(columns_by_id, inner.group_by_column_id)
    count_col = _column_ref(columns_by_id, inner.count_column_id)

    _, entity = columns_by_id[inner.group_by_column_id]
    if entity.id != inner.entity_id:
        raise InnerAggregationColumnError(
            f"KEEP using entity_id={inner.entity_id} — do not drop it or switch away from it. "
            f"The problem is only that column_id={inner.group_by_column_id} belongs to a "
            f"DIFFERENT entity ({entity.id}), not entity_id={inner.entity_id}. You must pick "
            f"entity {inner.entity_id}'s OWN column that plays the same role (its own foreign "
            f"key column, even if a same-named column exists on another entity) — select that "
            f"column via schema_linking, then reference its column_id here."
        )
    _, count_entity = columns_by_id[inner.count_column_id]
    if count_entity.id != inner.entity_id:
        raise InnerAggregationColumnError(
            f"KEEP using entity_id={inner.entity_id} — do not drop it or switch away from it. "
            f"The problem is only that count_column_id={inner.count_column_id} belongs to a "
            f"DIFFERENT entity ({count_entity.id}), not entity_id={inner.entity_id}. Both "
            f"group_by_column_id and count_column_id must be columns belonging to entity "
            f"{inner.entity_id} itself."
        )

    inner_select = (
        exp.select(group_col.as_("group_key"), exp.Count(this=count_col).as_(inner.alias))
        .from_(entity.physical_path)
        .group_by(group_col)
    )

    outer_alias_col = exp.column(inner.alias)
    subquery = exp.Subquery(this=inner_select, alias=exp.TableAlias(this=exp.to_identifier("dist")))
    outer = (
        exp.select(outer_alias_col, exp.Count(this=exp.Star()).as_("row_count"))
        .from_(subquery)
        .group_by(outer_alias_col)
        .order_by(exp.Ordered(this=outer_alias_col, desc=False))
    )
    return outer


def generate_sql(session: Session, join_plan: JoinPlan, query_plan: QueryPlan) -> str:
    """Convenience wrapper returning the SQL string directly. Prefer generate_sql_ast()
    when the result will be passed to validate_sql(), so it can validate the AST instead
    of re-parsing text that may contain unparseable-but-valid Dremio-specific syntax."""
    return generate_sql_ast(session, join_plan, query_plan).sql()


def _left_joined_entity_ids(join_plan: JoinPlan) -> set[int]:
    """Entities brought in via LEFT JOIN can contribute NULL rows (no match on the join key).
    Grouping/ranking by a column from one of these without excluding NULLs lets an orphaned-row
    bucket (e.g. child rows with no matching parent) silently win a ranking or pollute a
    per-group count — the aggregate is real, but the label naming which group it belongs to
    is missing, so the result answers a different question than asked."""
    return {
        step.to_entity_id for step in join_plan.steps if step.join_type == JoinType.LEFT
    }


def _effective_group_by(plan: QueryPlan) -> list[int]:
    """SQL requires every non-aggregated SELECT column to appear in GROUP BY. Rather than
    trust the model to remember this, code enforces it: any output_column that isn't the
    aggregation target is auto-added to the effective GROUP BY set."""
    if plan.aggregation_column_id is None and not plan.count_rows:
        return list(plan.group_by_columns)

    group_by = list(dict.fromkeys(plan.group_by_columns))
    for cid in plan.output_columns:
        if cid != plan.aggregation_column_id and cid not in group_by:
            group_by.append(cid)
    return group_by


def _all_referenced_column_ids(plan: QueryPlan) -> list[int]:
    ids = set(plan.output_columns) | set(plan.group_by_columns)
    if plan.aggregation_column_id is not None:
        ids.add(plan.aggregation_column_id)
    if plan.order_by_column_id is not None:
        ids.add(plan.order_by_column_id)
    for f in plan.filters:
        if f.column_id is not None:
            ids.add(f.column_id)
    return list(ids)


def _load_columns(session: Session, column_ids: list[int]) -> dict[int, tuple[EntityColumn, Entity]]:
    if not column_ids:
        return {}

    rows = session.exec(
        select(EntityColumn, Entity)
        .join(Entity, EntityColumn.entity_id == Entity.id)
        .where(EntityColumn.id.in_(column_ids))
    ).all()

    result = {}
    for column, entity in rows:
        result[column.id] = (column, entity)
    return result


def _column_ref(columns_by_id: dict, column_id: int) -> exp.Column:
    if column_id not in columns_by_id:
        raise SQLGenerationError(f"Plan referenced unknown column_id={column_id}")

    column, entity = columns_by_id[column_id]
    # render_from_clause() references tables by their bare name (unaliased, no catalog/db
    # prefix) in ON clauses, so column refs must match using just the table name too.
    table_name = entity.physical_path.split(".")[-1]
    return exp.column(column.physical_name, table=table_name)


def _build_filter_condition(columns_by_id: dict, f) -> exp.Expression:
    if f.glossary_sql_expression:
        # Glossary expressions are curated by humans, not generated by the model here — this
        # is the one place we trust a pre-existing SQL string, and only that string. Some
        # glossary expressions use Dremio/Calcite-specific syntax (e.g. TRY_CONVERT_FROM(...
        # AS ROW(...))) that SQLGlot's generic dialect cannot parse into an AST, even though
        # it runs fine on Dremio (verified separately). Embed it as an opaque raw fragment
        # instead of parsing it, so it round-trips unmodified. Note this means Step 7's
        # column-existence check does not cover identifiers referenced inside this fragment —
        # acceptable since the expression is human-curated, not model-generated.
        return exp.paren(exp.Var(this=f.glossary_sql_expression))

    if f.column_id is None or f.operator is None:
        raise SQLGenerationError(
            "Filter must set either glossary_sql_expression, or both column_id and operator"
        )

    col_ref = _column_ref(columns_by_id, f.column_id)
    # Normalize whitespace/underscore variants ("is not null" / "is_not_null" / "isnotnull")
    # the model sometimes uses interchangeably — treating them as distinct wasted retry cycles
    # for a purely cosmetic formatting difference.
    operator = f.operator.strip().lower().replace("_", " ")
    operator = " ".join(operator.split())

    if operator in ("is null", "isnull"):
        return exp.Is(this=col_ref, expression=exp.Null())
    if operator in ("is not null", "isnotnull"):
        return exp.Not(this=exp.Is(this=col_ref, expression=exp.Null()))
    if operator == "in":
        if f.value is None:
            raise SQLGenerationError("IN filter requires a comma-separated value list")
        values = [_literal_for_column(columns_by_id, f.column_id, v.strip()) for v in f.value.split(",")]
        return exp.In(this=col_ref, expressions=values)

    if operator not in _OPERATOR_MAP:
        raise SQLGenerationError(f"Unsupported filter operator: {f.operator!r}")
    if f.value is None:
        raise SQLGenerationError(f"Filter with operator {f.operator!r} requires a value")

    value_literal = _literal_for_column(columns_by_id, f.column_id, f.value)
    return _OPERATOR_MAP[operator](col_ref, value_literal)


def _literal_for_column(columns_by_id: dict, column_id: int, raw_value: str) -> exp.Expression:
    column, _ = columns_by_id[column_id]
    data_type = column.data_type.upper()

    if data_type == "BOOLEAN":
        return exp.Boolean(this=raw_value.strip().lower() in ("true", "1", "yes"))
    if data_type in ("INTEGER", "BIGINT", "INT", "FLOAT", "DOUBLE", "DECIMAL"):
        try:
            return exp.Literal.number(raw_value)
        except Exception:
            pass
    return exp.Literal.string(raw_value)


def _build_aggregation_expression(columns_by_id: dict, plan: QueryPlan) -> tuple[exp.Expression, str]:
    if plan.aggregation_function is None:
        raise SQLGenerationError("aggregation_column_id set without aggregation_function")

    try:
        agg_enum = DefaultAggregation(plan.aggregation_function.strip().lower())
    except ValueError as err:
        raise SQLGenerationError(f"Unknown aggregation_function: {plan.aggregation_function}") from err

    func_name = _AGG_FUNC_MAP[agg_enum]
    col_ref = _column_ref(columns_by_id, plan.aggregation_column_id)

    if agg_enum == DefaultAggregation.COUNT_DISTINCT:
        agg_expr = exp.Count(this=exp.Distinct(expressions=[col_ref]))
    else:
        agg_expr = exp.func(func_name, col_ref)

    column, _ = columns_by_id[plan.aggregation_column_id]
    alias = f"{agg_enum.value}_{column.physical_name}"
    return agg_expr, alias


def _build_select_expressions(columns_by_id: dict, plan: QueryPlan) -> list[exp.Expression]:
    expressions: list[exp.Expression] = []

    for cid in plan.output_columns:
        if plan.aggregation_column_id is not None and cid == plan.aggregation_column_id:
            continue
        column, _ = columns_by_id[cid]
        expressions.append(_column_ref(columns_by_id, cid).as_(column.physical_name))

    if plan.aggregation_column_id is not None:
        agg_expr, alias = _build_aggregation_expression(columns_by_id, plan)
        expressions.append(agg_expr.as_(alias))
    elif plan.count_rows:
        expressions.append(exp.Count(this=exp.Star()).as_("row_count"))

    if not expressions:
        raise SQLGenerationError("Plan produced no output columns")

    return expressions


def _build_order_expression(columns_by_id: dict, plan: QueryPlan) -> exp.Ordered | None:
    if plan.order_by_aggregation:
        if plan.count_rows:
            target = exp.Count(this=exp.Star())
        elif plan.aggregation_column_id is not None:
            target, _ = _build_aggregation_expression(columns_by_id, plan)
        else:
            raise SQLGenerationError("order_by_aggregation set without an aggregation or count_rows")
    elif plan.order_by_column_id is not None:
        target = _column_ref(columns_by_id, plan.order_by_column_id)
    else:
        return None

    direction = (plan.order_by_direction or "desc").strip().lower()
    return exp.Ordered(this=target, desc=direction == "desc")
