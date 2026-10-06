"""The parts of a QuerySpec, written with real names (agents.name, count_conversations) instead of ids.

Code assembles them from the specialist agents' answers (plan.py), then `assemble` turns names into
ids and builds the QuerySpec.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from src.pipeline_v4.agents.retrieval import PickedTable, PickedValue
from src.pipeline_v4.spec import DerivedOp, TimeGrain

Status = Literal["ok", "clarify", "cannot_answer"]
Compare = Literal["=", "!=", ">", ">=", "<", "<="]


class _Answer(BaseModel):
    status: Status = Field(default="ok", description="ok, clarify (ask the user) or cannot_answer")
    message: str | None = Field(default=None, description="the question to ask, or why it can't be answered")
    options: list[str] = Field(default_factory=list, description="choices for the clarifying question")
    assumptions: list[str] = Field(default_factory=list, description="choices made that the user should know")


# ── metric agent ──

class MetricPick(BaseModel):
    name: str = Field(description="result column name, snake_case, e.g. <a>_count or <measure>_cur")
    metric: str = Field(description="metric name, as listed")
    period: str | None = Field(default=None, description="period key from `periods`, or empty for all time")


class DerivedPick(BaseModel):
    name: str
    op: DerivedOp
    args: list[str] = Field(description="names of metrics or earlier derived values")
    scale: float = 1.0
    window: int = 3


class PerPick(BaseModel):
    column: str = Field(description="column to compute per, e.g. <a>.<x_id> (per <X>)")
    metrics: list[MetricPick]
    include_zero: bool = False


class SummaryPick(BaseModel):
    name: str
    agg: Literal["avg", "median", "min", "max", "sum", "count"]
    of: str | None = None


class HavingPick(BaseModel):
    field: str
    op: Compare
    value: float


class RankPick(BaseModel):
    by: str
    direction: Literal["asc", "desc"] = "desc"
    top: int


class PeriodNeed(BaseModel):
    key: str = Field(description="short key, e.g. cur, prev, h1")
    phrase: str = Field(description="the time phrase of the question it stands for")


class MetricOut(_Answer):
    shape: Literal["aggregate", "detail"] = "aggregate"
    table: str | None = Field(default=None, description="detail shape: name of the table whose rows are listed")
    metrics: list[MetricPick] = Field(default_factory=list)
    derived: list[DerivedPick] = Field(default_factory=list)
    per: PerPick | None = None
    summaries: list[SummaryPick] = Field(default_factory=list)
    having: list[HavingPick] = Field(default_factory=list)
    rank: RankPick | None = None
    limit: int | None = None
    periods: list[PeriodNeed] = Field(default_factory=list)


# ── dimension agent ──

class DimensionPick(BaseModel):
    column: str = Field(description="column as table.column, e.g. <x>.<x_id>")
    time_grain: TimeGrain | None = None


class BucketPick(BaseModel):
    of: str = Field(description="a per metric name")
    edges: list[float]


class OrderPick(BaseModel):
    field: str
    direction: Literal["asc", "desc"] = "desc"


class DimensionOut(_Answer):
    dimensions: list[DimensionPick] = Field(default_factory=list)
    buckets: BucketPick | None = None
    partition_by: list[str] = Field(default_factory=list, description="columns: top N within each of these")
    columns: list[str] = Field(default_factory=list, description="detail shape: columns to show")
    order_by: list[OrderPick] = Field(default_factory=list)


# ── filter agent ──

class FilterPick(BaseModel):
    column: str = Field(description="column as table.column")
    op: Literal["=", "!=", "in", "not_in", ">", ">=", "<", "<=", "is_null", "is_not_null"]
    values: list[str] = Field(default_factory=list, description="stored codes, never labels")
    reason: str | None = None


class PeriodPick(BaseModel):
    key: str
    start: str = Field(description="first day, YYYY-MM-DD")
    end: str = Field(description="day after the last day, YYYY-MM-DD")
    label: str | None = None


class SetConditionPick(BaseModel):
    op: Compare
    value: float


class SetPick(BaseModel):
    name: str
    key_column: str = Field(description="column whose values form the set, e.g. <a>.<x_id>")
    metric: str | None = Field(default=None, description="metric name, needed with having")
    having: list[SetConditionPick] = Field(default_factory=list)
    filters: list[FilterPick] = Field(default_factory=list)
    segments: list[str] = Field(default_factory=list)
    period: str | None = None


class SetFilterPick(BaseModel):
    column: str
    op: Literal["in_set", "not_in_set"]
    set: str


class FilterOut(_Answer):
    filters: list[FilterPick] = Field(default_factory=list)
    segments: list[str] = Field(default_factory=list, description="business terms of kind segment")
    periods: list[PeriodPick] = Field(default_factory=list)
    sets: list[SetPick] = Field(default_factory=list)
    set_filters: list[SetFilterPick] = Field(default_factory=list)
    include_default_filters: bool = True
    detail_period: str | None = None


# ── specialist answers ──

class TablesOut(BaseModel):
    tables: list[PickedTable] = Field(default_factory=list)


class TermsOut(BaseModel):
    terms: list[str] = Field(default_factory=list)


class ValuesOut(BaseModel):
    values: list[PickedValue] = Field(default_factory=list)


Kind = Literal["total", "grouped", "top_n", "trend", "compare_periods", "list_rows", "rows_with", "rows_without",
               "per_summary"]


class IntentOut(BaseModel):
    """The router's reading of the question, put together by code from small schema calls."""

    kind: Kind
    top_n: int | None = None
    direction: Literal["desc", "asc"] = "desc"
    time_grain: TimeGrain | None = None
    count_rows: bool = False
    listed_table: str | None = None
    related_table: str | None = None
    within: str | None = None      # top N taken inside each of this ("agent" in "theo từng agent")


class KindOut(BaseModel):
    kind: Kind


class RankOut(BaseModel):
    top_n: int = Field(description="how many; 'nhất' / 'most' alone = 1")
    direction: Literal["desc", "asc"] = Field(description="desc = most/largest/highest, asc = least/smallest/lowest")
    within: str | None = Field(default=None, description="when the top N is taken separately inside each of "
                               "something ('top 5 <A> theo từng <X>', 'mỗi <X> 3 <A>'): the words naming that "
                               "something, as written (<X>); null for a plain top N")


class GrainOut(BaseModel):
    time_grain: TimeGrain


class RowsOut(BaseModel):
    listed_table: str = Field(description="the table whose rows are listed or counted")
    related_table: str = Field(description="rows with/without: the table of the related rows; else empty")
    count_rows: bool = Field(description="true: how many such rows; false: list them")


class MeasureOut(BaseModel):
    status: Status = "ok"
    message: str | None = None
    options: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)


class TimeOut(BaseModel):
    periods: list[PeriodPick] = Field(default_factory=list)


class GroupPick(BaseModel):
    column: str
    phrase: str = ""           # the words of the question that ask for this split

    @model_validator(mode="before")
    @classmethod
    def _from_name(cls, v: object) -> object:
        return {"column": v} if isinstance(v, str) else v


class GroupOut(BaseModel):
    columns: list[GroupPick] = Field(default_factory=list)


class RelatedPick(BaseModel):
    table: str                 # the related table
    has: bool = True           # False: rows that have no related row


class ConditionOut(BaseModel):
    filters: list[FilterPick] = Field(default_factory=list)
    segments: list[str] = Field(default_factory=list)


class RelatedOut(BaseModel):
    related: list[RelatedPick] = Field(default_factory=list)  # rows that have (or have no) related rows


class SetCondition(BaseModel):
    metric: str
    op: Compare
    value: float


class SetOut(BaseModel):
    conditions: list[SetCondition] = Field(default_factory=list)


class PerOut(BaseModel):
    column: str | None = None
    include_zero: bool = False
    summaries: list[Literal["avg", "median", "min", "max", "sum", "count"]] = Field(default_factory=list)


# ── step 6: present ──

ChartType = Literal["bar", "bar_horizontal", "stacked_bar", "line", "area", "stacked_area", "pie", "donut",
                    "scatter", "combo", "treemap"]
DataOp = Literal["top_n_other", "pivot", "bins", "running_total", "regroup", "sort_rows"]


class DataStep(BaseModel):
    """One transform of a chart dataset (pipeline_v4/chart_data.py); replayed by code, never by a model."""
    key: str                       # d1, d2, … (given by code)
    op: DataOp
    source: str = "original"       # the dataset it starts from
    measure: str | None = None
    x: str | None = None
    series: str | None = None
    by: str | None = None
    agg: Literal["sum", "avg", "min", "max", "count"] | None = None
    n: int | None = None
    bins: int | None = None
    direction: Literal["asc", "desc"] | None = None
    label: str | None = None       # what to call the column it adds, in the question's language


class ChartPick(BaseModel):
    type: ChartType
    x: str
    y: list[str]
    title: str
    recommended: bool = False
    data: str = "original"         # which dataset it draws


class ChartsOut(BaseModel):
    datasets: list[DataStep] = Field(default_factory=list)
    charts: list[ChartPick] = Field(default_factory=list)


class FollowUp(BaseModel):
    question: str
    based_on: list[str] = Field(default_factory=list)  # profile names the question relies on


class FollowUpsOut(BaseModel):
    questions: list[FollowUp] = Field(default_factory=list)


# ── decomposer (before step 3) ──

class SubQuestion(BaseModel):
    """A sub-question as the pipeline runs it (ids given by code: q1, q2, …)."""
    id: str
    question: str
    depends_on: list[str] = Field(default_factory=list)


class PartOut(BaseModel):
    question: str = Field(description="a standalone question, in the user's language, using the words of the "
                                      "standalone question")
    depends_on: list[int] = Field(default_factory=list, description="numbers (1, 2, …) of earlier parts whose "
                                                                     "result this one needs; empty when it stands alone")


class DecomposeOut(BaseModel):
    standalone: str = Field(default="", description="the user's question rewritten to stand alone: references to the "
                                        "conversation ('tháng trước', 'các <A> đó', 'còn … thì sao') replaced by "
                                        "what they refer to; otherwise the question as written")
    parts: list[PartOut] = Field(default_factory=list, description="usually ONE part equal to standalone; 2-3 only "
                                                                     "for separate results")


# ── scout (answers the decomposer's questions about the data) ──

class ScoutFact(BaseModel):
    fact: str
    names: list[str] = Field(default_factory=list)   # profile names the fact is about


class ScoutOut(BaseModel):
    facts: list[ScoutFact] = Field(default_factory=list)
