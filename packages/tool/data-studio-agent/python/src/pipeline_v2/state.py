"""The pipeline_v2 'phiếu' — one accumulating state ticket filled slot-by-slot across steps.

Unlike v1 (where each step returned its own dataclass and the orchestrator threaded them
manually), v2 carries a single mutable ticket. Every step reads the accumulated state and
writes its own slots. This mirrors the design doc's JSON ticket and makes each step's
contract explicit: what it needs (already-filled slots) and what it produces (its slots).

Nothing here talks to an LLM or the DB — it's a pure data container.
"""

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class JoinStrategy(StrEnum):
    """How the FROM/JOIN skeleton must be shaped to avoid wrong numbers from fan-out.
    Decided deterministically in step 6 (see step6_joins.choose_strategy)."""

    NONE = "none"          # single table, no join
    DIRECT_OK = "direct_ok"  # 1:N join but we count the many-side itself — fan-out is intended
    PRE_AGG = "pre_agg"      # aggregate the expanding branch in a subquery before joining
    SPLIT_CTE = "split_cte"  # 2+ parallel 1:N branches — one CTE per branch, then join back


class SlotStatus(StrEnum):
    MISSING = "missing"
    FILLED = "filled"
    AMBIGUOUS = "ambiguous"


@dataclass
class EntityMatch:
    term: str
    entity_id: int
    table_physical_path: str
    confidence: float


@dataclass
class BusinessRule:
    """A resolved business term (e.g. 'intent node'). filter_sql is the glossary's curated
    sql_expression, reused verbatim (see design doc: glossary dẫn dắt, metadata xác minh)."""

    term: str
    glossary_id: int
    applies_to_entity_id: int | None
    filter_sql: str
    verified: bool


@dataclass
class MetricSpec:
    """Something to aggregate. expr_column_id is None for a plain COUNT(*)."""

    agg: str                       # count | count_distinct | sum | avg | min | max
    expr_column_id: int | None
    alias: str
    scoped_by_term: str | None = None  # links to a BusinessRule whose filter scopes this metric


@dataclass
class DimensionSpec:
    """A grouping concept. id_column_id drives GROUP BY/JOIN; label_column_id drives SELECT."""

    entity_id: int
    id_column_id: int
    label_column_id: int | None


@dataclass
class FilterSpec:
    """A plain WHERE condition. Glossary-sourced conditions live in BusinessRule instead."""

    column_id: int
    operator: str
    value: str | None


@dataclass
class TimeSpec:
    column_id: int
    start: str | None
    end: str | None          # half-open: start <= t < end
    tz: str | None
    granularity: str | None


@dataclass
class JoinEdge:
    from_entity_id: int
    to_entity_id: int
    from_column_physical: str
    to_column_physical: str
    cardinality: str
    # True when traversing this edge, moving away from the grain table, expands rows (1 -> N).
    expands_from_grain: bool


@dataclass
class JoinPlanV2:
    strategy: JoinStrategy = JoinStrategy.NONE
    edges: list[JoinEdge] = field(default_factory=list)
    fanout_note: str | None = None
    # For pre_agg/split_cte: which entities are the expanding branches to fold into subqueries.
    expanding_branch_entity_ids: list[int] = field(default_factory=list)
    unreachable_entity_ids: list[int] = field(default_factory=list)


@dataclass
class EdgeCases:
    soft_delete_conditions: list[str] = field(default_factory=list)  # raw SQL fragments
    dedup_note: str | None = None
    order_by: str | None = None      # e.g. "intent_node_count DESC"
    limit: int | None = None


@dataclass
class OutputHints:
    ranking: bool = False
    limit: int | None = None
    direction: str | None = None     # asc | desc


@dataclass
class ClarificationNeeded:
    """Raised into state (not thrown) when a step cannot safely auto-decide. The orchestrator
    turns a non-empty list of these into a single clarify turn back to the user."""

    slot: str
    question: str
    options: list[str] = field(default_factory=list)


@dataclass
class PipelineState:
    question: str

    # step 0
    intent: str | None = None
    detected_terms: list[str] = field(default_factory=list)
    output_hints: OutputHints = field(default_factory=OutputHints)

    # step 1
    entities: list[EntityMatch] = field(default_factory=list)

    # step 2
    business_rules: list[BusinessRule] = field(default_factory=list)

    # step 3
    grain: str | None = None
    grain_entity_id: int | None = None

    # step 4
    metrics: list[MetricSpec] = field(default_factory=list)
    dimensions: list[DimensionSpec] = field(default_factory=list)
    select_column_ids: list[int] = field(default_factory=list)
    group_by_column_ids: list[int] = field(default_factory=list)

    # step 5
    filters: list[FilterSpec] = field(default_factory=list)
    time: TimeSpec | None = None

    # step 6
    join_plan: JoinPlanV2 | None = None

    # step 7
    edge_cases: EdgeCases = field(default_factory=EdgeCases)

    # cross-cutting
    assumptions: list[str] = field(default_factory=list)
    clarifications: list[ClarificationNeeded] = field(default_factory=list)

    # the set of tables the query must touch, grown as steps pick columns from new entities
    target_entity_ids: set[int] = field(default_factory=set)

    def entity_ids(self) -> list[int]:
        return [e.entity_id for e in self.entities]

    def add_assumption(self, note: str) -> None:
        if note not in self.assumptions:
            self.assumptions.append(note)

    def needs_clarification(self) -> bool:
        return bool(self.clarifications)

    def to_debug_dict(self) -> dict[str, Any]:
        """Flat snapshot for debug logging — mirrors the design doc's JSON ticket."""
        return {
            "question": self.question,
            "intent": self.intent,
            "detected_terms": self.detected_terms,
            "entities": [e.__dict__ for e in self.entities],
            "business_rules": [r.__dict__ for r in self.business_rules],
            "grain": self.grain,
            "grain_entity_id": self.grain_entity_id,
            "metrics": [m.__dict__ for m in self.metrics],
            "dimensions": [d.__dict__ for d in self.dimensions],
            "select_column_ids": self.select_column_ids,
            "group_by_column_ids": self.group_by_column_ids,
            "filters": [f.__dict__ for f in self.filters],
            "time": self.time.__dict__ if self.time else None,
            "join_plan": {
                "strategy": self.join_plan.strategy.value,
                "edges": [e.__dict__ for e in self.join_plan.edges],
                "fanout_note": self.join_plan.fanout_note,
            } if self.join_plan else None,
            "edge_cases": self.edge_cases.__dict__,
            "assumptions": self.assumptions,
            "clarifications": [c.__dict__ for c in self.clarifications],
        }
