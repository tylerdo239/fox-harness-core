"""Step 5 — Filters + time (LLM).

Plain WHERE conditions (glossary-sourced conditions are already handled as business_rules in
step 2, so this only covers ordinary user filters). Relative time phrases ('tháng trước',
'last month') are normalized into a half-open interval [start, end) with an explicit
timezone — the design doc's slot 7, the second most error-prone slot after grain.

Reuses v1's guardrail idea: an id/key filter whose value the user never actually named is
dropped and recorded as an assumption rather than answering a different question.
"""

from pydantic import BaseModel, Field
from sqlmodel import Session

from src.database.models import EntityColumn
from src.database.models.enums import ColumnRole, SemanticType
from src.pipeline_v2 import derive
from src.pipeline_v2.state import FilterSpec, PipelineState, TimeSpec
from src.services.llm_client import LLMClient

DEFAULT_TZ = "Asia/Ho_Chi_Minh"

_INSTRUCTIONS = """\
# Task
Extract plain **WHERE filters** and a **time range**. Do NOT write SQL.

# Rules
- Only use `column_id`s from the candidates. **Ground every value** in the provided `sample_values`
  or the question text — never pick an arbitrary sample value for an id the user didn't name.
- **Relative time** ("last month", "tháng trước", "this quarter") → resolve to a concrete
  half-open range: `start` (inclusive) and `end` (exclusive) as `YYYY-MM-DD`, plus the
  `time_column_id` it applies to. Use today's date as reference.
- Do **not** invent filters the question didn't ask for. An empty filter list is fine.
"""


class FilterOut(BaseModel):
    column_id: int
    operator: str = Field(description="= != > >= < <= like in")
    value: str


class TimeOut(BaseModel):
    time_column_id: int | None = None
    start: str | None = None
    end: str | None = None
    granularity: str | None = None


class FilterPlan(BaseModel):
    filters: list[FilterOut] = Field(default_factory=list)
    time: TimeOut | None = None


def _render(session: Session, state: PipelineState) -> str:
    lines = [f"Intent: {state.intent or state.question}", "", "Candidate columns with sample values:"]
    for eid in state.target_entity_ids or set(state.entity_ids()):
        for c in derive.exposed_columns(session, eid):
            sem = c.semantic_type.value if c.semantic_type else "?"
            samples = f" samples={c.sample_values[:8]}" if c.sample_values else ""
            lines.append(f"[column_id={c.id}] {c.display_name} (type={sem}){samples}")
    return "\n".join(lines)


async def run_step5(session: Session, llm_client: LLMClient, state: PipelineState) -> None:
    plan = await llm_client.run_structured(
        _render(session, state), output_schema=FilterPlan, instructions=_INSTRUCTIONS
    )

    question_lower = state.question.lower()
    for f in plan.filters:
        column = session.get(EntityColumn, f.column_id)
        if column is None:
            continue
        # drop an id/key filter whose value the user never named — v1's grounding guardrail
        is_identifier = column.role == ColumnRole.KEY or column.semantic_type == SemanticType.ID
        value_named = f.value and f.value.strip().lower() in question_lower
        if is_identifier and not value_named:
            state.add_assumption(
                f"Dropped filter on {column.display_name}: value {f.value!r} was not named in "
                f"the question. Please specify which one you mean."
            )
            continue
        state.filters.append(FilterSpec(column_id=f.column_id, operator=f.operator.strip(), value=f.value))
        state.target_entity_ids.add(column.entity_id)

    if plan.time and plan.time.time_column_id and (plan.time.start or plan.time.end):
        col = session.get(EntityColumn, plan.time.time_column_id)
        if col is not None:
            state.time = TimeSpec(
                column_id=plan.time.time_column_id,
                start=plan.time.start,
                end=plan.time.end,
                tz=DEFAULT_TZ,
                granularity=plan.time.granularity,
            )
            state.target_entity_ids.add(col.entity_id)
