"""QuerySpec: the typed form the v4 agents fill in. The compiler turns it into SQL.

No slot takes SQL text. Every reference is an id from the profile (column, metric, glossary term)
or a value from a closed list, so a spec can be checked against the profile before any SQL exists.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from src.data_profile.models import TypedFilter

TimeGrain = Literal["day", "week", "month", "quarter", "year"]
SortDir = Literal["asc", "desc"]


class Period(BaseModel):
    """A half-open date range [start, end) in the table's business time zone."""

    start: date
    end: date
    label: str | None = None  # "tháng 8/2026"

    @model_validator(mode="after")
    def _ordered(self) -> "Period":
        if self.start >= self.end:
            raise ValueError("period start must be before its end")
        return self


class Dimension(BaseModel):
    column_id: str                    # a real column or a JSON field ("<column id>#<path>")
    time_grain: TimeGrain | None = None  # for date/time columns: group by day, week, month…


class MetricRef(BaseModel):
    name: str                         # result column name, e.g. "conv_aug"
    metric_id: str
    period: str | None = None         # key in QuerySpec.periods; None = no time limit


DerivedOp = Literal[
    "growth", "ratio", "diff",        # two values in the same row
    "share_of_total", "vs_avg",       # one value against all rows (of the same time bucket)
    "running_sum", "prev", "change", "pct_change", "moving_avg",  # along the time-grain dimension
]
ONE_ARG_OPS = {"share_of_total", "vs_avg", "running_sum", "prev", "change", "pct_change", "moving_avg"}
WINDOW_OPS = ONE_ARG_OPS              # computed with OVER (...)
TIME_OPS = {"running_sum", "prev", "change", "pct_change", "moving_avg"}


class Derived(BaseModel):
    name: str
    op: DerivedOp
    args: list[str]                   # names of metrics or other derived values
    scale: float = 1.0                # e.g. 100 for a percentage
    window: int = Field(default=3, ge=2, le=36)  # moving_avg: number of time buckets

    @model_validator(mode="after")
    def _arity(self) -> "Derived":
        need = 1 if self.op in ONE_ARG_OPS else 2
        if len(self.args) != need:
            raise ValueError(f"{self.op} takes {need} argument(s)")
        return self


class Having(BaseModel):
    field: str                        # a metric or derived name
    op: Literal["=", "!=", ">", ">=", "<", "<="]
    value: float


class Rank(BaseModel):
    by: str                           # a metric or derived name
    direction: SortDir = "desc"
    top: int = Field(ge=1, le=1000)
    partition_by: list[str] = Field(default_factory=list)  # dimension column ids: top N per group


class OrderBy(BaseModel):
    field: str                        # a result column name
    direction: SortDir = "desc"


class SetCondition(BaseModel):
    op: Literal["=", "!=", ">", ">=", "<", "<="]
    value: float


class KeySet(BaseModel):
    """The keys of rows that match a sub-question, e.g. "orders that contain SKU X" or
    "customers with more than 5 orders in August". Used through QuerySpec.set_filters."""

    key_column_id: str                # whose values form the set (e.g. order_items.order_id)
    metric_id: str | None = None      # with `having`: keep keys whose metric passes
    having: list[SetCondition] = Field(default_factory=list)
    filters: list[TypedFilter] = Field(default_factory=list)
    segments: list[str] = Field(default_factory=list)
    period: str | None = None         # key in QuerySpec.periods, on the set table's time column
    include_default_filters: bool = True

    @model_validator(mode="after")
    def _having_needs_metric(self) -> "KeySet":
        if self.having and not self.metric_id:
            raise ValueError("a set with `having` needs a metric_id")
        return self


class SetFilter(BaseModel):
    column_id: str
    op: Literal["in_set", "not_in_set"]
    set: str                          # key in QuerySpec.sets


class PerStep(BaseModel):
    """Compute metrics once per value of a column first (e.g. per customer), then summarize
    those values with `summaries` and/or group them with `buckets`."""

    column_id: str
    metrics: list[MetricRef] = Field(min_length=1)
    include_zero: bool = False        # also keep keys without rows (counted as 0); column must be a grain key


class Summary(BaseModel):
    name: str
    agg: Literal["avg", "median", "min", "max", "sum", "count"]
    of: str | None = None             # a per metric name; empty only for count (number of keys)

    @model_validator(mode="after")
    def _of(self) -> "Summary":
        if self.agg != "count" and not self.of:
            raise ValueError(f"{self.agg} needs `of` (a per metric name)")
        return self


class Bucket(BaseModel):
    """Group the per values into ranges: edges [2, 5] → "< 2", "2 – < 5", "≥ 5"."""

    of: str                           # a per metric name
    edges: list[float] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def _increasing(self) -> "Bucket":
        if any(b <= a for a, b in zip(self.edges, self.edges[1:], strict=False)):
            raise ValueError("bucket edges must be increasing")
        return self


class QuerySpec(BaseModel):
    shape: Literal["aggregate", "detail"] = "aggregate"

    # aggregate
    dimensions: list[Dimension] = Field(default_factory=list)
    metrics: list[MetricRef] = Field(default_factory=list)
    derived: list[Derived] = Field(default_factory=list)
    having: list[Having] = Field(default_factory=list)
    rank: Rank | None = None

    # two-level aggregation (instead of `metrics`)
    per: PerStep | None = None
    summaries: list[Summary] = Field(default_factory=list)
    buckets: Bucket | None = None

    # detail (list individual rows of one table)
    entity_id: str | None = None
    columns: list[str] = Field(default_factory=list)
    time_column_id: str | None = None   # detail: which date the period applies to (default: table's main)
    detail_period: str | None = None

    # both
    filters: list[TypedFilter] = Field(default_factory=list)  # on any table the query reaches
    segments: list[str] = Field(default_factory=list)          # glossary term ids (kind = segment)
    sets: dict[str, KeySet] = Field(default_factory=dict)
    set_filters: list[SetFilter] = Field(default_factory=list)  # column in / not in a set
    periods: dict[str, Period] = Field(default_factory=dict)
    include_default_filters: bool = True
    order_by: list[OrderBy] = Field(default_factory=list)
    limit: int | None = Field(default=None, ge=1, le=1000)
