"""9b — Chart recommendations: the LLM picks the chart type(s) + field mapping, code validates.

Pure-code heuristics were too rigid (a 2-dimension result or a single total fell through to a
bare table). Now the LLM looks at the result's columns + sample rows and proposes chart specs
(type + which fields map to x/y); code then VALIDATES each spec against the real data — fields
must exist, a numeric axis must actually be numeric — dropping invalid ones. We GUARANTEE at
least one chart: a single-value result becomes a `stat` card, anything else falls back to a data
table. Returned specs are field-mapping only (never rendered images), so the UI stays interactive.
"""

from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

from src.services.llm_client import LLMClient

_MAX_SAMPLE_ROWS = 8

_INSTRUCTIONS = """\
# Role
You recommend how to VISUALIZE a SQL query result. You are given the columns and a few sample
rows. Propose 1–3 chart specs, best-fit first.

# Chart types
- **line** — a trend over an ordered/numeric/date x-axis (e.g. value by age, by month).
- **bar** — compare a measure across categories (e.g. count per workflow/agent).
- **scatter** — correlation between two numeric measures.
- **stat** — a single headline number (use when the result is ONE row with ONE key metric).
- **table** — raw rows; a safe fallback, but prefer a real chart when the data supports one.

# How to choose
- Identify which columns are **dimensions** (labels/categories/dates) vs **measures** (the
  numbers). Put a dimension on `x`; put measure column(s) in `y` (multiple y = multiple series).
- One category dimension + a measure → **bar**. An ordered/date dimension + measure(s) → **line**.
- Two measures, no useful dimension → **scatter** (x = first measure, y = [second]).
- A single number (one row, one metric) → **stat** with `value_field` = that metric column.
- Only pick columns that EXIST in the result. Never invent field names.

# Language
Write each chart's `title` and `description` in the same language as the question (Vietnamese if
the question is Vietnamese).

# Output
`charts`: list of {type, title, description, x, y, value_field}. Set `recommended: true` on the
single best one. `x`/`y`/`value_field` may be null when not applicable to the type.
"""


@dataclass
class ChartSpec:
    type: str                       # line | bar | scatter | stat | table
    title: str
    description: str
    x: str | None = None            # x-axis / category field
    y: list[str] = field(default_factory=list)  # measure field(s)
    value_field: str | None = None  # for 'stat': the single metric column
    recommended: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type, "title": self.title, "description": self.description,
            "x": self.x, "y": self.y, "value_field": self.value_field, "recommended": self.recommended,
        }


# ── LLM output schema ──

class _ChartOut(BaseModel):
    type: str = Field(description="line | bar | scatter | stat | table")
    title: str
    description: str = ""
    x: str | None = None
    y: list[str] = Field(default_factory=list)
    value_field: str | None = None
    recommended: bool = False


class _ChartPlan(BaseModel):
    charts: list[_ChartOut] = Field(default_factory=list)


def _is_numeric_value(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    if isinstance(v, str):
        try:
            float(v)
            return True
        except ValueError:
            return False
    return False


def _render_prompt(question: str, display_columns: list[dict[str, Any]], rows: list[dict[str, Any]]) -> str:
    fields = list(rows[0].keys())
    col_meta = {c.get("physical_name"): c for c in display_columns}
    lines = [f"Question: {question}", "", "Result columns:"]
    for f in fields:
        m = col_meta.get(f, {})
        role = m.get("role") or "?"
        sem = m.get("semantic_type") or "?"
        sample = next((r.get(f) for r in rows if r.get(f) is not None), None)
        lines.append(f"- {f} (role={role}, type={sem}, sample={sample!r})")
    lines.append(f"\n{len(rows)} rows. Sample:")
    for r in rows[:_MAX_SAMPLE_ROWS]:
        lines.append(f"  {r}")
    return "\n".join(lines)


async def recommend_charts(
    llm_client: LLMClient,
    question: str,
    display_columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
) -> list[ChartSpec]:
    """LLM proposes charts; code validates + guarantees at least one. Async (one LLM call)."""
    if not rows:
        return []

    fields = set(rows[0].keys())
    try:
        plan = await llm_client.run_structured(
            _render_prompt(question, display_columns, rows), output_schema=_ChartPlan, instructions=_INSTRUCTIONS
        )
        proposed = plan.charts
    except Exception:  # noqa: BLE001 — never let a chart-LLM failure break the answer
        proposed = []

    valid = [spec for c in proposed if (spec := _validate(c, fields, rows)) is not None]

    # guarantee at least one chart
    if not valid:
        valid = [_fallback(display_columns, rows)]
    # ensure exactly one recommended
    if not any(s.recommended for s in valid):
        valid[0].recommended = True
    # always offer a raw table too (unless the only chart already is one)
    if not any(s.type == "table" for s in valid):
        valid.append(ChartSpec(
            type="table", title="Bảng dữ liệu", description=f"{len(rows)} dòng dữ liệu.",
            x=None, y=list(rows[0].keys()),
        ))
    return valid


def _validate(c: _ChartOut, fields: set[str], rows: list[dict[str, Any]]) -> ChartSpec | None:
    """Drop a proposed chart whose fields don't exist or whose numeric axis isn't numeric."""
    t = c.type.lower().strip()
    if t == "table":
        return ChartSpec(type="table", title=c.title or "Bảng dữ liệu",
                         description=c.description, y=list(rows[0].keys()), recommended=c.recommended)
    if t == "stat":
        vf = c.value_field or (c.y[0] if c.y else None)
        if not vf or vf not in fields:
            return None
        return ChartSpec(type="stat", title=c.title, description=c.description,
                         value_field=vf, recommended=c.recommended)

    # line/bar/scatter need an x and at least one numeric y that all exist
    ys = [y for y in c.y if y in fields]
    if t == "scatter":
        if not c.x or c.x not in fields or not ys:
            return None
        if not _numeric_col(c.x, rows) or not _numeric_col(ys[0], rows):
            return None
        return ChartSpec(type="scatter", title=c.title, description=c.description,
                         x=c.x, y=[ys[0]], recommended=c.recommended)
    if t in ("line", "bar"):
        if not c.x or c.x not in fields or not ys:
            return None
        # y columns must be numeric to plot
        ys = [y for y in ys if _numeric_col(y, rows)]
        if not ys:
            return None
        return ChartSpec(type=t, title=c.title, description=c.description,
                         x=c.x, y=ys, recommended=c.recommended)
    return None


def _numeric_col(name: str, rows: list[dict[str, Any]]) -> bool:
    sample = next((r.get(name) for r in rows if r.get(name) is not None), None)
    return _is_numeric_value(sample)


def _fallback(display_columns: list[dict[str, Any]], rows: list[dict[str, Any]]) -> ChartSpec:
    """No valid LLM chart — pick a sensible default so there's always >=1 chart.
    A single row with a single numeric column → stat card; otherwise a table."""
    fields = list(rows[0].keys())
    if len(rows) == 1 and len(fields) == 1 and _numeric_col(fields[0], rows):
        return ChartSpec(type="stat", title=fields[0], description="", value_field=fields[0], recommended=True)
    # a single-row multi-column result: stat on the first numeric column if any
    if len(rows) == 1:
        num = next((f for f in fields if _numeric_col(f, rows)), None)
        if num:
            return ChartSpec(type="stat", title=num, description="", value_field=num, recommended=True)
    return ChartSpec(type="table", title="Bảng dữ liệu", description=f"{len(rows)} dòng dữ liệu.",
                     y=fields, recommended=True)
