"""Edit toolkits of step 4 (question → QuerySpec parts): one per specialist, 1-2 decision tools each."""

from datetime import date
from typing import Any, ClassVar

from pydantic import ValidationError

from src.pipeline_v4.agents.base import Draft
from src.pipeline_v4.agents.parts import (
    ConditionOut,
    FilterPick,
    GroupOut,
    GroupPick,
    MeasureOut,
    PeriodPick,
    PerOut,
    RelatedOut,
    RelatedPick,
    SetCondition,
    SetOut,
    TimeOut,
)
from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.context import Names
from src.pipeline_v4.tools.common import (
    Scalar,
    as_text,
    canonical,
    filter_problem,
    is_time,
    not_in_question,
    same,
    validation_message,
)
from src.pipeline_v4.tools.drafts import AnswerDraftToolkit, DraftToolkit
from src.pipeline_v4.tools.guide import Run

SUMMARIES = ("avg", "median", "min", "max", "sum", "count")


class MeasureTools(AnswerDraftToolkit):
    parts: ClassVar = {"metrics": str}
    phrased: ClassVar = True

    def __init__(self, draft: Draft[MeasureOut], names: Names, **kwargs: Any) -> None:
        self.h = names
        super().__init__("measure_tools", draft, [self.add_metric], **kwargs)

    async def add_metric(self, phrase: str, metric: str) -> str:
        """Pick a metric from the Metrics list.

        Args:
            phrase: the words of the question this metric measures, only those (e.g. "<A>";
                not the conditions around it).
            metric: metric name, as listed (count_<table> counts rows).
        """
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        name, problem = canonical(self.h, metric, "metric")
        if name is None:
            return self.error(problem)
        if name in self.draft.value.metrics:
            return self.duplicate(name)
        self.draft.value.metrics.append(name)
        return self.ok(f"metric {name}")


class TimeTools(DraftToolkit):
    parts: ClassVar = {"periods": lambda x: x.start}
    phrased: ClassVar = True

    def __init__(self, draft: Draft[TimeOut], **kwargs: Any) -> None:
        super().__init__("time_tools", draft, [self.add_period], **kwargs)

    async def add_period(self, phrase: str, start: str, end: str, label: str = "") -> str:
        """Add a time range.

        Args:
            phrase: the words of the question that name this period, e.g. "tháng 8".
            start: first day, YYYY-MM-DD.
            end: the day AFTER the last day, YYYY-MM-DD.
            label: how to show it, e.g. tháng 8/2026.
        """
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        try:
            if date.fromisoformat(start) >= date.fromisoformat(end):
                return self.error(f"start {start} is not before end {end}",
                                  "send end = the day AFTER the last day of the range (a month: the 1st of the next month)")
        except ValueError:
            return self.error(f"dates must be YYYY-MM-DD (got start={start!r}, end={end!r})",
                              "send both dates as YYYY-MM-DD, e.g. the 1st of the month for a month")
        periods = self.draft.value.periods
        periods.append(PeriodPick(key=f"p{len(periods) + 1}", start=start, end=end, label=label or None))
        return self.ok(f"{start} … {end} (end excluded)")


class GroupingTools(DraftToolkit):
    parts: ClassVar = {"columns": lambda x: x.column}
    phrased: ClassVar = True

    def __init__(self, draft: Draft[GroupOut], names: Names, cat: Catalog, **kwargs: Any) -> None:
        self.h, self.cat = names, cat
        super().__init__("grouping_tools", draft, [self.add_grouping], **kwargs)

    async def add_grouping(self, phrase: str, column: str) -> str:
        """Split the result by this column (not by time: that is handled separately).

        Args:
            phrase: the words of the question that ask for this split, e.g. "theo <X>".
            column: table.column; for a thing with its own table, its id column.
        """
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        name, problem = canonical(self.h, column, "column")
        if name is None:
            return self.error(problem)
        if is_time(self.cat, self.h, name):
            return self.error(f"{name} is a date/time column: splitting by time steps is handled by another step",
                              "leave time out; add_grouping only for what the result is split by besides time, "
                              "or call done")
        if any(g.column == name for g in self.draft.value.columns):
            return self.duplicate(name)
        self.draft.value.columns.append(GroupPick(column=name, phrase=phrase.strip()))
        return self.ok(f"group by {name}")


class ConditionTools(DraftToolkit):
    parts: ClassVar = {"filters": lambda x: x.column, "segments": str}
    phrased: ClassVar = True

    def __init__(self, draft: Draft[ConditionOut], names: Names, cat: Catalog, **kwargs: Any) -> None:
        self.h, self.cat = names, cat
        super().__init__("condition_tools", draft, [self.add_filter, self.add_segment], **kwargs)

    async def add_filter(self, phrase: str, column: str, op: str, values: list[Scalar] | None = None,
                         value: Scalar | None = None) -> str:
        """Keep only rows meeting a condition the question states.

        Args:
            phrase: the words of the question that state it.
            column: table.column.
            op: =, !=, in, not_in, >, >=, <, <=, is_null or is_not_null.
            values: stored codes (see list_values); none for is_null / is_not_null.
            value: one stored code (same as values with one item).
        """
        given = [*(values or []), *([] if value is None else [value])]
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        name, problem = canonical(self.h, column, "column")
        if name is None:
            return self.error(problem)
        if is_time(self.cat, self.h, name):
            return self.error(f"{name} is a date/time column: time ranges are handled by another step",
                              "leave time out; add_filter only for the other conditions, or call done")
        try:
            pick = FilterPick(column=name, op=op, values=[as_text(v) for v in given])  # type: ignore[arg-type]
        except ValidationError as err:
            return self.error(validation_message(err), "fix the argument named in the error and send the call again")
        if (problem := filter_problem(self.cat, self.h, name, pick.op, pick.values)):
            return self.error(problem)
        self.draft.value.filters.append(pick)
        return self.ok(f"{name} {op} {', '.join(pick.values)}".rstrip())

    async def add_segment(self, phrase: str, term: str) -> str:
        """Keep only rows of a business term of kind segment.

        Args:
            phrase: the words of the question that use the term.
            term: the term as shown.
        """
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        name, problem = canonical(self.h, term, "term")
        if name is None:
            return self.error(problem)
        if self.cat.glossary[self.h.resolve(name, "term")].get("kind") != "segment":
            kind = self.cat.glossary[self.h.resolve(name, "term")].get("kind") or "other"
            return self.error(f"{name} is a term of kind {kind}, not a segment (a set of rows)",
                              Run.of("search_term", pattern=phrase),
                              "add_filter on the columns its definition names instead")
        if name in self.draft.value.segments:
            return self.duplicate(name)
        self.draft.value.segments.append(name)
        return self.ok(f"segment {name}")


class RelatedTools(DraftToolkit):
    parts: ClassVar = {"related": lambda x: x.table}
    phrased: ClassVar = True

    def __init__(self, draft: Draft[RelatedOut], names: Names, **kwargs: Any) -> None:
        self.h = names
        super().__init__("related_tools", draft, [self.add_has_related], **kwargs)

    async def add_has_related(self, phrase: str, table: str, has: bool = True) -> str:
        """Keep only rows that have at least one related row in another table ('<A> với <B>', '<A> có
        <B>'), or with has=false only rows that have none.

        Args:
            phrase: the words of the question that say it, e.g. "với <B>".
            table: the related table.
            has: true = has related rows; false = has none.
        """
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        name, problem = canonical(self.h, table, "table")
        if name is None:
            return self.error(problem)
        if any(same(x.table, name) for x in self.draft.value.related):
            return self.duplicate(name)
        self.draft.value.related.append(RelatedPick(table=name, has=bool(has)))
        return self.ok(f"rows {'with' if has else 'without'} related {name} rows")


class SetTools(DraftToolkit):
    parts: ClassVar = {"conditions": lambda x: x.metric}
    phrased: ClassVar = True

    def __init__(self, draft: Draft[SetOut], names: Names, **kwargs: Any) -> None:
        self.h = names
        super().__init__("set_tools", draft, [self.add_condition], **kwargs)

    async def add_condition(self, phrase: str, metric: str, op: str, value: float) -> str:
        """A condition on how many related rows each listed row has ('more than 10 <A>').

        Args:
            phrase: the words of the question that state the number, e.g. "hơn 10 <A>".
            metric: a metric of the related table.
            op: =, !=, >, >=, < or <=.
            value: a number.
        """
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        if (op, value) in (("=", 0), ("<=", 0)) or (op == "<" and value <= 1):
            return self.error(f"{op} {value:g} means 'has no related rows', which the question type already says",
                              "add a condition only for a number of rows the question states ('more than <n> <A>'), "
                              "or call done")
        name, problem = canonical(self.h, metric, "metric")
        if name is None:
            return self.error(problem)
        try:
            self.draft.value.conditions.append(SetCondition(metric=name, op=op, value=value))  # type: ignore[arg-type]
        except ValidationError as err:
            return self.error(validation_message(err), "send op as one of =, !=, >, >=, <, <= and value as a number")
        return self.ok(f"{name} {op} {value:g}")


class PerTools(DraftToolkit):
    parts: ClassVar = {"summaries": str}
    phrased: ClassVar = True

    def __init__(self, draft: Draft[PerOut], names: Names, **kwargs: Any) -> None:
        self.h = names
        super().__init__("per_tools", draft, [self.set_per, self.add_summary], **kwargs)

    async def set_per(self, phrase: str, column: str, include_zero: bool = False) -> str:
        """The column whose values the measure is computed per ('per <X>' → <a>.<x_id>).

        Args:
            phrase: the words of the question that say it, e.g. "mỗi <X>".
            column: table.column.
            include_zero: also count values with no rows as 0.
        """
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        name, problem = canonical(self.h, column, "column")
        if name is None:
            return self.error(problem)
        self.draft.value.column, self.draft.value.include_zero = name, include_zero
        return self.ok(f"per {name}")

    async def add_summary(self, agg: str) -> str:
        """How to summarize the per values.

        Args:
            agg: avg, median, min, max, sum, or count (number of per values).
        """
        if agg not in SUMMARIES:
            return self.error(f"agg {agg!r} is unknown", f"send agg as one of: {', '.join(SUMMARIES)} (average → avg)")
        if agg in self.draft.value.summaries:
            return self.duplicate(agg)
        self.draft.value.summaries.append(agg)  # type: ignore[arg-type]
        return self.ok(f"summary {agg}")
