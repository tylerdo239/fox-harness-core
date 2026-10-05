"""Parser output schemas — the typed contract each agent's Parser fills from Worker markdown.

Each schema is a SLICE of the ticket (see docs/agent-loop-architecture.md). Kept deliberately
small and flat: a weak parser model fills a shallow schema far more reliably than a nested one.

Schema objects are referenced by NAME, not numeric id: an entity by its `table` name, a column by
`table.column`. An LLM pattern-matches on names but hallucinates numeric ids (they carry no signal).
Code resolves names→ids against the retrieval candidates (src/pipeline_v3/resolve.py); a name
outside the candidate set is rejected, not silently mis-resolved.
"""

from pydantic import BaseModel, Field, field_validator


class IntakeOut(BaseModel):
    language: str = Field(description="ISO code, e.g. 'vi' or 'en'")
    intent: str = Field(description="one short phrase, e.g. 'aggregate + group-by breakdown'")
    grouping: bool = Field(description="true if the question wants a per-X breakdown")
    ranking: bool = Field(default=False, description="true if top-N / most / least")
    rank_limit: int | None = Field(
        default=None, description="for a ranking: how many to keep — 'top 5'→5, 'nhiều nhất'/'most'→1"
    )
    rank_direction: str = Field(
        default="desc", description="'desc' for most/nhiều nhất/largest, 'asc' for least/ít nhất/smallest"
    )
    share: bool = Field(default=False, description="true if % of total / tỉ lệ / share")
    # SHARE-OF-CATEGORY: '% of X that are VALUE' ('node type assistant chiếm bao nhiêu %'). The VALUE
    # must NOT be a WHERE filter (that removes the denominator) — instead group by its category column
    # and compute VALUE_count / total * 100 in the Transform. share_of_value holds that target value.
    share_of_value: str | None = Field(
        default=None,
        description="ONLY when the question asks what % of the rows are a SPECIFIC category value "
        "(e.g. 'node type assistant chiếm bao nhiêu %' → 'assistant'). The exact value being asked "
        "about. null for a normal share (% of a measure across groups).",
    )
    # a THRESHOLD-on-aggregate (HAVING) question: the per-group aggregate must pass a numeric
    # condition — 'X that have MORE THAN / AT LEAST / FEWER THAN n Y'. The flat SQL can't express
    # HAVING, so we compute per-X counts in SQL and apply the threshold in the pandas Transform.
    threshold: bool = Field(
        default=False,
        description="true when the question filters GROUPS by a numeric condition on their per-group "
        "aggregate — 'X có more than/at least/fewer than N Y' (e.g. 'agents có TRÊN 3 workflows'). "
        "This covers BOTH 'how many such X' AND 'list such X'. False for a normal count/breakdown.",
    )
    threshold_op: str = Field(
        default=">", description="the comparison for the threshold: one of > >= < <= == (e.g. 'trên'/"
        "'hơn'/'more than'→'>', 'ít nhất'/'at least'→'>=', 'dưới'/'fewer than'→'<')"
    )
    threshold_value: int | None = Field(
        default=None, description="the number N in the threshold condition (e.g. 'trên 3 workflows'→3)"
    )
    threshold_count: bool = Field(
        default=False,
        description="ONLY for a threshold question: true if it asks HOW MANY such groups ('bao nhiêu "
        "X', 'số lượng X') → return one number. False if it asks to LIST/SHOW the groups ('liệt kê X', "
        "'những X nào', 'list the X') → keep the passing rows so they are shown.",
    )
    detected_terms: list[str] = Field(
        default_factory=list, description="the concrete nouns to ground, e.g. ['workflow','agent']"
    )

    @field_validator("rank_direction", mode="before")
    @classmethod
    def _rank_direction_default(cls, v):  # weak model emits rank_direction: null — coerce to default
        return "desc" if v is None else v

    @field_validator("threshold_op", mode="before")
    @classmethod
    def _threshold_op_default(cls, v):  # weak model emits threshold_op: null — coerce to default
        return ">" if v is None else v


class GrainOut(BaseModel):
    grain_entity: str = Field(description="the TABLE NAME one result row is 'per', e.g. 'agents'")
    grain_reason: str = Field(description="one line: why this entity is the grain")


class MetricItem(BaseModel):
    alias: str = Field(description="snake_case output column, e.g. 'workflow_count'")
    agg: str = Field(description="one of: count, count_distinct, sum, avg, min, max")
    column: str | None = Field(
        default=None, description="column to aggregate as 'table.column', e.g. 'workflows.workflow_id'; null for COUNT(*)"
    )
    source_phrase: str = Field(description="the phrase this metric answers, e.g. 'số workflow'")


class MetricOut(BaseModel):
    metrics: list[MetricItem]


class DimensionItem(BaseModel):
    id_column: str = Field(description="the id/key column that drives GROUP BY, as 'table.column'")
    label_column: str | None = Field(
        default=None, description="the name/label column for SELECT, as 'table.column'"
    )


class SliceOut(BaseModel):
    dimensions: list[DimensionItem]
    dropped_note: str = Field(default="", description="any dimension dropped to avoid over-grouping")


class FilterItem(BaseModel):
    column: str = Field(description="the column to filter, as 'table.column'")
    operator: str = Field(description="one of: = != <> > >= < <= like in")
    value: str = Field(description="the filter value, grounded in the question or sample_values")


class TimeRange(BaseModel):
    time_column: str | None = Field(default=None, description="the date column, as 'table.column'")
    start: str | None = Field(default=None, description="YYYY-MM-DD inclusive")
    end: str | None = Field(default=None, description="YYYY-MM-DD exclusive (half-open)")


class FilterOut(BaseModel):
    filters: list[FilterItem] = Field(default_factory=list)
    time: TimeRange | None = None
    glossary_terms: list[str] = Field(
        default_factory=list,
        description="business-glossary phrases in the question that scope the result (e.g. a curated "
        "domain concept). Each is applied as its vetted SQL predicate. Empty if none.",
    )


class CodeOut(BaseModel):
    """A block of pandas code the agent writes to transform/merge DataFrames.
    The code must assign its output DataFrame to a variable named `result`."""

    needs_code: bool = Field(description="false if no transform/merge is needed")
    code: str = Field(default="", description="pandas code; assign the output to `result`")
    explanation: str = Field(default="", description="one line: what the code does")


class ComposeOut(BaseModel):
    """The compose agent's DECISION about combining sub-question results — the agent decides whether
    a merge makes sense and on which key; the code then performs the merge deterministically (so a
    weak model never writes join code that can KeyError)."""

    should_merge: bool = Field(
        description="true ONLY if the sub-results share a common grain and merging them side-by-side "
        "into one table is meaningful (e.g. all per-agent → one row per agent with each measure). "
        "false if they have different grains / no shared key — then they stay as separate results."
    )
    merge_key: str | None = Field(
        default=None,
        description="the EXACT column name present in EVERY sub-result to join on (prefer an id/key "
        "column over a repeating label). Required when should_merge=true; null otherwise.",
    )
    how: str = Field(default="outer", description="join type: 'outer' (keep all) | 'inner'")
    reason: str = Field(default="", description="one line: why merge / why not")

    @field_validator("how", mode="before")
    @classmethod
    def _how_default(cls, v):
        return "outer" if v not in ("outer", "inner") else v


class InsightOut(BaseModel):
    answer_markdown: str = Field(description="the narrative answer in the user's language")
    cited_numbers: list[str] = Field(
        default_factory=list, description="every number quoted in the answer, as strings"
    )
    chart_type: str = Field(default="table", description="line | bar | scatter | stat | table")
    chart_x: str | None = Field(default=None, description="category/x-axis field name")
    chart_y: list[str] = Field(default_factory=list, description="measure field name(s)")


class ChartItem(BaseModel):
    chart_type: str = Field(description="bar | pie | line | scatter")
    chart_x: str | None = Field(default=None, description="EXACT column name for x-axis (category)")
    chart_y: list[str] = Field(default_factory=list, description="EXACT column name(s) for the measure(s)")
    title: str = Field(default="", description="short chart title")
    recommended: bool = Field(default=False, description="true for the single best/primary chart")
    # optional pandas transform to shape THIS chart's data (e.g. a pie of share needs a pct column,
    # which SQL never returns). Operates on `df` (the SQL result), assigns the output to `result`.
    # Empty = the chart uses the raw SQL rows directly.
    transform_code: str = Field(
        default="", description="optional pandas code on `df` → `result` to derive this chart's data"
    )

    @field_validator("chart_y", mode="before")
    @classmethod
    def _y_to_list(cls, v):  # weak model returns chart_y as a bare string or null — coerce to list
        if v is None:
            return []
        return v if isinstance(v, list) else [v]


class ChartsOut(BaseModel):
    charts: list[ChartItem] = Field(
        default_factory=list, description="1-3 charts giving different useful views of the result"
    )


class ChartReviewOut(BaseModel):
    satisfied: bool = Field(description="true if the chart clearly answers the question")
    feedback: str = Field(default="", description="if not satisfied: what's wrong with the chart")


class FieldPickOut(BaseModel):
    """The Field agent's choice of which ACTUAL columns to plot for a chart, having seen the real
    (post-transform) data. If no columns fit the chart type, suitable=false + feedback for Transform."""

    suitable: bool = Field(description="true if the data has columns that fit this chart type")
    x: str | None = Field(default=None, description="EXACT column for x-axis / category, or null")
    y: list[str] = Field(default_factory=list, description="EXACT numeric measure column(s)")
    value_field: str | None = Field(default=None, description="for a stat: the single numeric column")
    feedback: str = Field(
        default="", description="if not suitable: what data the chart needs that isn't present, "
        "so the Transform can produce it (e.g. 'a stat needs one aggregated numeric value')"
    )

    @field_validator("y", mode="before")
    @classmethod
    def _y_none_to_list(cls, v):  # weak model returns y: null when unsuitable — coerce to []
        return v if isinstance(v, list) else []


class ClarifyOut(BaseModel):
    needs_clarification: bool = Field(
        description="true ONLY when the question is genuinely ambiguous and cannot be answered safely"
    )
    clarifying_question: str = Field(
        default="", description="the question to ask the user, in their language (if ambiguous)"
    )
    options: list[str] = Field(
        default_factory=list, description="concrete options for the user to pick from"
    )
    display_columns: list[str] = Field(
        default_factory=list,
        description="columns to SHOW the user as 'table.column' (label + context), when NOT ambiguous",
    )
    reason: str = Field(default="", description="one line: why these columns / why ambiguous")


class SubQuestion(BaseModel):
    id: str = Field(description="short id, e.g. 'q1'")
    question: str = Field(description="one self-contained sub-question")


class FollowUpsOut(BaseModel):
    questions: list[str] = Field(
        default_factory=list,
        description="2-3 natural follow-up questions, each in the SAME language as the original "
        "question, grounded ONLY in the shown available-but-unused schema",
    )


class RankOut(BaseModel):
    is_ranking: bool = Field(description="true if the question asks for top-N / most / least / a rank")
    limit: int = Field(default=1, description="how many to keep: 'top 5'→5, 'most'/'nhất'→1")
    direction: str = Field(default="desc", description="'desc' for most/largest, 'asc' for least/smallest")

    @field_validator("limit", mode="before")
    @classmethod
    def _limit_default(cls, v):  # weak model emits limit: null explicitly — coerce to the default
        return 1 if v is None else v

    @field_validator("direction", mode="before")
    @classmethod
    def _direction_default(cls, v):  # weak model emits direction: null — coerce to the default
        return "desc" if v is None else v


class ReviewOut(BaseModel):
    satisfied: bool = Field(
        description="true if the result fully answers the question as a user would expect"
    )
    feedback: str = Field(
        default="", description="if not satisfied: what is wrong / missing, for the re-plan"
    )
    missing: list[str] = Field(
        default_factory=list, description="specific things the answer lacks (e.g. 'conversation count')"
    )


class DecomposeOut(BaseModel):
    is_multi: bool = Field(description="true if the question needs splitting")
    sub_questions: list[SubQuestion] = Field(default_factory=list)
    combine_strategy: str = Field(
        default="merge_on_grain",
        description="how to combine: merge_on_grain | stack | filter_by | none",
    )
