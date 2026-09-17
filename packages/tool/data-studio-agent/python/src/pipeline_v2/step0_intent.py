"""Step 0 — Normalize intent (single LLM call).

Rephrases the raw question into a canonical business question, extracts the main noun
phrases (later mapped to tables in step 1), and reads output signals (ranking / limit /
direction). Touches no schema — pure language understanding, so a wrong schema guess here
is impossible; it only sets up what the grounded steps look for.
"""

from pydantic import BaseModel, Field

from src.pipeline_v2.state import OutputHints, PipelineState
from src.services.llm_client import LLMClient

_INSTRUCTIONS = """\
# Role
You normalize a data question **before any schema is known**. Do NOT invent table or column names.

# Tasks
- **Rephrase** the question into one clear, standalone business question. Keep the user's language.
- **Extract noun phrases** that likely name business entities or concepts (e.g. `workflow`,
  `intent node`, `khách hàng`). Keep multi-word domain terms as a SINGLE item — `intent node`,
  not `intent` + `node` — so the glossary step can match them whole.
- **Detect output signals**: is this a ranking / superlative (`top`, `most`, `nhất`, `nhiều nhất`)?
  If so:
  - set `ranking = true`
  - set `direction` — `desc` for most/highest/top, `asc` for least/lowest
  - set `limit` if a count is named (`top 5` → 5, a plain "the most" → 1)
"""


class IntentResult(BaseModel):
    intent: str = Field(description="One clear standalone rephrasing of the question.")
    detected_terms: list[str] = Field(
        default_factory=list,
        description="Main noun phrases likely naming entities/concepts, multi-word terms kept whole.",
    )
    ranking: bool = Field(default=False, description="True if the question asks for a ranking/superlative.")
    limit: int | None = Field(default=None, description="Row limit implied by the question, e.g. 5 for 'top 5'.")
    direction: str | None = Field(default=None, description="asc | desc, if a ranking direction is implied.")


async def run_step0(llm_client: LLMClient, state: PipelineState) -> None:
    result = await llm_client.run_structured(
        state.question, output_schema=IntentResult, instructions=_INSTRUCTIONS
    )
    state.intent = result.intent
    state.detected_terms = result.detected_terms
    state.output_hints = OutputHints(
        ranking=result.ranking,
        limit=result.limit,
        direction=result.direction,
    )
