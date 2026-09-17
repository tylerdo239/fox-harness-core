from pydantic import BaseModel, Field
from sqlmodel import Session, select

from src.database.models import EntityColumn, Metric, VerifiedQuery
from src.database.models.enums import ColumnRole, SemanticType
from src.services.embedding_client import EmbeddingClient
from src.services.grounding import GroundingResult
from src.services.llm_client import LLMClient
from src.services.vector_store import VectorStore

TOP_K_VERIFIED_QUERIES = 3

_INSTRUCTIONS = [
    "You are a Data Engineer planning how to answer a question. Output a plan, NOT SQL.",
    "Only use the entity_ids and column_ids provided as candidates — never invent identifiers.",
    "Ground every filter value in the sample_values, value_glossary, or glossary sql_expression provided.",
    "If a filter value is not clearly grounded in the provided data, do not guess it — omit the filter "
    "and note it in `assumptions` instead.",
    "aggregation and group_by columns must respect each column's role: only 'measure' columns are "
    "aggregated, only 'dimension' columns are grouped by.",
    "If a metric's default_filters are given, apply them even if the user didn't ask for them explicitly.",
    "For each filter: set column_id + operator + value for a plain comparison, OR set only "
    "glossary_sql_expression when reusing a glossary term's SQL verbatim. Never combine both, "
    "and never put a full SQL condition string in the value field.",
    "Never write a placeholder like '<workflow_id>' or 'TBD' as a filter value. If the specific "
    "value the user means isn't in the sample_values or the question itself, omit that filter "
    "entirely and explain why in `assumptions` — do not include the filter with a fake value.",
    "NEVER pick an arbitrary value from sample_values to fill in a filter the user did not specify, "
    "even to fix a previous error. sample_values exist so you can recognize a value the user DID "
    "mention (e.g. matching 'active' to a status column) — they are not a menu to choose from when "
    "no value was given. If a filter on an id/key column has no value named in the question, omit "
    "the filter and explain in `assumptions` that the user needs to specify which one.",
    "If the question asks for a superlative or ranking — 'most', 'highest', 'top', 'least', "
    "'lowest', 'bottom', 'nhất', 'nhiều nhất', 'cao nhất', 'ít nhất' — set order_by_direction "
    "(desc for most/highest/top, asc for least/lowest/bottom) and limit (1 unless the question "
    "names a count like 'top 5'). Set order_by_aggregation=true to sort by the aggregated value "
    "itself (e.g. 'workflow with the most nodes' sorts by the COUNT), or set order_by_column_id "
    "to sort by a plain output column instead. Do not leave the answer as an unsorted, unlimited "
    "list when the question asks for a single best/worst result.",
    "For a plain 'how many X' question that just counts matching rows, set count_rows=true "
    "instead of picking a column for aggregation_column_id. Do NOT aggregate a key or dimension "
    "column just to produce a row count — there is no measure column needed for a simple count. "
    "Never set both count_rows and aggregation_column_id. order_by_aggregation also works with "
    "count_rows (e.g. 'which X has the most Y' when Y has no natural measure column). "
    "IMPORTANT: if the question wants a single total (no 'per X' breakdown, e.g. 'how many "
    "active workflows do we have'), leave output_columns EMPTY when count_rows=true — adding "
    "an id/key column to output_columns turns the single total into a group_by, giving one row "
    "per group instead of one total row. Only include an output_column alongside count_rows "
    "when the question explicitly asks for a breakdown (e.g. 'how many nodes per workflow').",
    "If the question asks for a DISTRIBUTION of a count — 'how many X have how many Y each' "
    "(e.g. 'how many conversations collected how many variables', 'X có bao nhiêu Y theo từng "
    "Z') — this needs two levels of counting: first count Y per X, then count how many X fall "
    "into each Y-count bucket. Set `inner_aggregation` for the first level (group_by_column_id "
    "= X's id column, count_column_id = the Y column being counted, alias = a name for the "
    "count). The outer grouping by that count and counting X's per bucket happens "
    "automatically — leave the outer plan's group_by_columns and aggregation_column_id empty, "
    "set count_rows=true, set entity_ids to [inner_aggregation.entity_id] (required but "
    "otherwise unused here), and leave output_columns empty since the outer query only has the "
    "two auto-generated columns (the count value, and how many groups had it). Do NOT try to "
    "answer a distribution question with a single-level plan — a flat COUNT(*) or COUNT(Y) "
    "alone cannot express it, it only gives one total.",
]


class PlanFilter(BaseModel):
    column_id: int | None = Field(
        default=None,
        description="The column_id this filter applies to. Leave null only when using "
        "a glossary_sql_expression that references multiple columns or a computed value.",
    )
    operator: str | None = Field(
        default=None,
        description="Comparison operator: one of = != > >= < <= IN LIKE IS NULL IS NOT NULL. "
        "Required unless glossary_sql_expression is set.",
    )
    value: str | None = Field(
        default=None,
        description="The literal value to compare against, grounded from sample_values or "
        "value_glossary (e.g. \"active\", \"true\", \"2024-01-01\"). Do not include quotes or "
        "the column name — just the raw value. Not needed for IS NULL / IS NOT NULL.",
    )
    glossary_sql_expression: str | None = Field(
        default=None,
        description="If this filter comes from a business glossary term, paste its "
        "sql_expression here verbatim instead of filling operator/value.",
    )


class InnerAggregation(BaseModel):
    """A per-group count computed first, then treated as a dimension for an outer
    group_by/count — e.g. 'how many conversations collected how many variables' needs
    (1) count variables PER conversation, THEN (2) count conversations PER that count.
    Only set this for genuinely two-level 'distribution of a count' questions; a plain
    'count X per Y' question needs only the outer plan's own group_by, not this."""

    entity_id: int = Field(description="Entity holding the rows to count per group.")
    group_by_column_id: int = Field(
        description="column_id to group by for the inner count — e.g. conversation_id, "
        "so each group is one conversation."
    )
    count_column_id: int = Field(
        description="column_id whose occurrences are counted per group — e.g. variable_name, "
        "so the inner count is 'how many variables this conversation has'."
    )
    alias: str = Field(
        description="Name for the inner count value, used as the outer plan's group_by "
        "dimension — e.g. 'variable_count'. Must be a valid SQL identifier (letters, "
        "digits, underscores only)."
    )


class QueryPlan(BaseModel):
    inner_aggregation: InnerAggregation | None = Field(
        default=None,
        description="Set ONLY for two-level 'distribution of a count' questions (see "
        "InnerAggregation docstring) — e.g. 'how many conversations collected how many "
        "variables', 'X có bao nhiêu Y theo từng Z'. When set, the outer plan's "
        "group_by_columns must include the inner_aggregation.alias as a group, and "
        "count_rows should usually be true to count how many groups fall in each bucket. "
        "Leave null for ordinary single-level count/group/aggregate questions — this is "
        "rare, only for genuine histograms/distributions of a count.",
    )
    entity_ids: list[int] = Field(description="Tables needed, in the order they should be joined from")
    output_columns: list[int] = Field(description="column_ids to include in the final SELECT")
    filters: list[PlanFilter] = Field(default_factory=list)
    group_by_columns: list[int] = Field(
        default_factory=list, description="column_ids to GROUP BY (dimension columns only)"
    )
    aggregation_column_id: int | None = Field(
        default=None, description="column_id to aggregate, if any (measure column only)"
    )
    aggregation_function: str | None = Field(
        default=None, description="sum | avg | count | count_distinct | min | max"
    )
    count_rows: bool = Field(
        default=False,
        description="Set true for a plain 'how many X' question that just counts matching "
        "rows (COUNT(*)) — no measure column needed. Mutually exclusive with "
        "aggregation_column_id: never set both. Do NOT aggregate a key/dimension column just "
        "to fake a row count — use this instead.",
    )
    time_grain: str | None = Field(default=None, description="e.g. day, week, month, quarter, year")
    order_by_column_id: int | None = Field(
        default=None,
        description="column_id to ORDER BY, if the question asks for a ranking/superlative "
        "over a plain output column. Mutually exclusive with order_by_aggregation.",
    )
    order_by_aggregation: bool = Field(
        default=False,
        description="Set true to ORDER BY the aggregated value (aggregation_column_id + "
        "aggregation_function) instead of a plain column — e.g. 'which X has the most Y'.",
    )
    order_by_direction: str | None = Field(
        default=None, description="asc | desc. Required if order_by_column_id or order_by_aggregation is set."
    )
    limit: int | None = Field(
        default=None, description="Row limit, e.g. 1 for 'the most', 5 for 'top 5'."
    )
    assumptions: list[str] = Field(
        default_factory=list, description="Any assumption made when a value could not be grounded"
    )


class PlanScopeError(Exception):
    """Raised when the plan violates a taxonomy scope decision: a glossary term was already
    judged (by taxonomy.check_scope) to be the operative definition for a concept in this
    question, but the plan answered that concept with a plain filter instead of the term's
    sql_expression. Routed back to PLAN with the violation named, rather than silently
    stripped, so the retry prompt can tell the model exactly which term it must use."""


async def build_plan(
    session: Session,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    question: str,
    grounding: GroundingResult,
    matched_metric_id: int | None = None,
    mandatory_glossary_ids: list[int] | None = None,
) -> QueryPlan:
    few_shot = await _find_similar_verified_queries(session, embedding_client, vector_store, question)
    columns = _load_columns(session, [c.id for c in grounding.columns])
    metric_context = _render_metric_context(session, matched_metric_id)
    mandatory_terms = _mandatory_glossary_terms(grounding, mandatory_glossary_ids)

    prompt = "\n\n".join(
        part
        for part in [
            _render_columns(columns),
            _render_grounding(grounding),
            _render_mandatory_terms(mandatory_terms),
            metric_context,
            few_shot,
            f"Question: {question}",
        ]
        if part
    )

    result = await llm_client.run_structured(prompt, output_schema=QueryPlan, instructions=_INSTRUCTIONS)
    result = _reject_ungrounded_filters(result, question, columns)
    _enforce_glossary_scope(result, mandatory_terms)
    return result


def _mandatory_glossary_terms(grounding: GroundingResult, mandatory_glossary_ids: list[int] | None):
    if not mandatory_glossary_ids:
        return []
    ids = set(mandatory_glossary_ids)
    return [g for g in grounding.glossary_terms if g.id in ids and g.sql_expression]


def _render_mandatory_terms(mandatory_terms: list) -> str:
    if not mandatory_terms:
        return ""
    lines = [
        "MANDATORY — a scope check already determined these glossary terms are the operative "
        "definition for concepts in this question. You MUST answer those concepts using the "
        "term's sql_expression via glossary_sql_expression. Writing a plain column_id/operator/"
        "value filter that tries to answer the same concept a different way is NOT ALLOWED, "
        "even if a sample value looks plausible:"
    ]
    for g in mandatory_terms:
        lines.append(f"- glossary '{g.term}': {g.sql_expression}")
    return "\n".join(lines)


def _enforce_glossary_scope(plan: QueryPlan, mandatory_terms: list) -> None:
    if not mandatory_terms:
        return

    used_expressions = {
        f.glossary_sql_expression.strip() for f in plan.filters if f.glossary_sql_expression
    }
    for term in mandatory_terms:
        if term.sql_expression.strip() not in used_expressions:
            raise PlanScopeError(
                f"The plan must use glossary term '{term.term}' (sql_expression: "
                f"{term.sql_expression}) to answer this question — a scope check already "
                f"determined it's the operative definition, but the plan didn't use it."
            )


_PLACEHOLDER_PATTERNS = ("<", ">", "tbd", "to be specified", "to_be_specified", "placeholder", "unknown_value")


def _looks_like_placeholder(value: str | None) -> bool:
    if value is None:
        return False
    lowered = value.strip().lower()
    return any(pattern in lowered for pattern in _PLACEHOLDER_PATTERNS)


def _reject_ungrounded_filters(
    plan: QueryPlan, question: str, columns: list[EntityColumn]
) -> QueryPlan:
    """Code-level guardrail against two ways the model can substitute a fake value for one
    the user never gave: (1) literal placeholder text like '<workflow_id>', and (2) picking
    an arbitrary REAL value from sample_values for an id/key column when the question never
    named a specific one — this passes as "grounded" but answers a different question than
    asked. Both are stripped here and recorded as assumptions instead of reaching SQL."""
    columns_by_id = {c.id: c for c in columns}
    question_lower = question.lower()

    kept_filters = []
    extra_assumptions = []

    for f in plan.filters:
        if _looks_like_placeholder(f.value):
            extra_assumptions.append(
                f"Filter on column_id={f.column_id} was dropped: the model produced a "
                f"placeholder value ({f.value!r}) instead of a grounded one."
            )
            continue

        if f.glossary_sql_expression and (f.column_id is not None or f.operator is not None):
            extra_assumptions.append(
                f"Filter combined glossary_sql_expression with a plain column_id/operator/value "
                f"(column_id={f.column_id}) — only the glossary_sql_expression was kept, since "
                f"a glossary term's SQL is meant to stand alone, not be duplicated by a guessed "
                f"plain filter for the same concept."
            )
            kept_filters.append(
                f.model_copy(update={"column_id": None, "operator": None, "value": None})
            )
            continue

        column = columns_by_id.get(f.column_id) if f.column_id is not None else None
        is_identifier_column = column is not None and (
            column.role == ColumnRole.KEY or column.semantic_type == SemanticType.ID
        )
        value_named_in_question = f.value is not None and f.value.strip().lower() in question_lower

        if is_identifier_column and f.value is not None and not value_named_in_question:
            extra_assumptions.append(
                f"Filter on column_id={f.column_id} ({column.display_name}) was dropped: "
                f"the value {f.value!r} was picked from sample data but was never named in "
                f"the question. Please specify which {column.display_name} you mean."
            )
            continue

        kept_filters.append(f)

    if extra_assumptions:
        plan = plan.model_copy(
            update={
                "filters": kept_filters,
                "assumptions": [*plan.assumptions, *extra_assumptions],
            }
        )

    return plan


def _load_columns(session: Session, column_ids: list[int]) -> list[EntityColumn]:
    if not column_ids:
        return []
    return session.exec(select(EntityColumn).where(EntityColumn.id.in_(column_ids))).all()


def _render_columns(columns: list[EntityColumn]) -> str:
    lines = ["Selected columns (role / semantic_type / default_aggregation):"]
    for c in columns:
        role = c.role.value if c.role else "?"
        sem = c.semantic_type.value if c.semantic_type else "?"
        agg = c.default_aggregation.value if c.default_aggregation else "-"
        lines.append(f"[column_id={c.id}] {c.display_name} (role={role}, type={sem}, default_agg={agg})")
    return "\n".join(lines)


def _render_grounding(grounding: GroundingResult) -> str:
    lines = ["Grounding facts (real data, use to write correct filter values):"]

    for e in grounding.entities:
        lines.append(f"- entity_id={e.id} '{e.display_name}': grain={e.grain_description or 'unknown'}")

    for c in grounding.columns:
        parts = [f"- column_id={c.id} '{c.display_name}':"]
        if c.sample_values:
            parts.append(f"sample_values={c.sample_values[:10]}")
        if c.value_glossary:
            parts.append(f"value_glossary={c.value_glossary}")
        if c.min_val is not None or c.max_val is not None:
            parts.append(f"range=[{c.min_val}, {c.max_val}]")
        if c.null_ratio is not None:
            parts.append(f"null_ratio={c.null_ratio}")
        lines.append(" ".join(parts))

    for r in grounding.relationships:
        lines.append(f"- relationship: entity {r.from_entity_id} -> {r.to_entity_id} is {r.cardinality}")

    for g in grounding.glossary_terms:
        lines.append(f"- glossary '{g.term}': {g.definition_text}")
        if g.sql_expression:
            lines.append(f"  sql_expression: {g.sql_expression}")

    return "\n".join(lines)


def _render_metric_context(session: Session, metric_id: int | None) -> str:
    if metric_id is None:
        return ""

    metric = session.get(Metric, metric_id)
    if metric is None:
        return ""

    lines = [f"Matched metric '{metric.name}':"]
    lines.append(f"  aggregation={metric.aggregation.value} on column_id={metric.measure_column_id}")
    if metric.default_filters:
        lines.append(f"  default_filters (apply these): {metric.default_filters}")
    if metric.allowed_dimension_column_ids:
        lines.append(f"  allowed_dimension_column_ids={metric.allowed_dimension_column_ids}")
    return "\n".join(lines)


async def _find_similar_verified_queries(
    session: Session, embedding_client: EmbeddingClient, vector_store: VectorStore, question: str
) -> str:
    if vector_store.count("verified_queries") == 0:
        return ""

    query_embedding = await embedding_client.embed_query(question)
    hits = vector_store.query(
        "verified_queries", query_embedding, n_results=TOP_K_VERIFIED_QUERIES, query_text=question
    )

    ids = hits.get("ids", [[]])[0]
    if not ids:
        return ""

    queries = session.exec(
        select(VerifiedQuery).where(VerifiedQuery.id.in_([int(i) for i in ids]))
    ).all()
    if not queries:
        return ""

    lines = ["Similar previously-verified questions and their SQL (for reference only):"]
    for q in queries:
        lines.append(f"Q: {q.nl_question}\nSQL: {q.sql}")
    return "\n".join(lines)
