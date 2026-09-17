"""Step 3 — Chốt grain (narrow LLM call).

Grain = what one result row represents. It's decided early because it drives GROUP BY and
determines whether a join fans out incorrectly. We seed the model with each candidate
entity's curated grain_description so it usually confirms an existing grain rather than
inventing one. The output is one sentence + which entity the grain is anchored on.
"""

from pydantic import BaseModel, Field
from sqlmodel import Session

from src.database.models import Entity
from src.pipeline_v2.state import PipelineState
from src.services.llm_client import LLMClient

_INSTRUCTIONS = """\
# Task
Decide the **GRAIN** of the answer: what does one row of the final result represent?

# Rules
- Pick the `grain_entity_id` from the candidate entities — the entity one result row is "per".
- For a **ranking** like "top 5 workflows by X", the grain is one row per **workflow**, so the
  grain entity is the workflow entity — NOT the entity holding the thing being counted.
- Write `grain` as a short "one row = ..." sentence in the user's language.
"""


class GrainResult(BaseModel):
    grain_entity_id: int = Field(description="entity_id that one result row is 'per'.")
    grain: str = Field(description="Short 'one row = ...' description.")


def _render(session: Session, state: PipelineState) -> str:
    lines = [f"Question intent: {state.intent or state.question}", "", "Candidate entities:"]
    for e in state.entities:
        entity = session.get(Entity, e.entity_id)
        grain = entity.grain_description if entity and entity.grain_description else "unknown"
        name = entity.display_name if entity else e.term
        lines.append(f"[entity_id={e.entity_id}] {name} — curated grain: {grain}")
    if state.output_hints.ranking:
        lines.append("\nNote: this is a ranking question — the grain is the ranked entity.")
    return "\n".join(lines)


async def run_step3(session: Session, llm_client: LLMClient, state: PipelineState) -> None:
    if not state.entities:
        return

    # step 1 already set the grain entity from the SUBJECT role tag — trust it, don't re-decide
    # (a second LLM call risked disagreeing with the subject). Just fill the grain TEXT.
    if state.grain_entity_id is not None:
        entity = session.get(Entity, state.grain_entity_id)
        state.grain = (entity.grain_description if entity else None) or "one row per record"
        return

    if len(state.entities) == 1:
        eid = state.entities[0].entity_id
        entity = session.get(Entity, eid)
        state.grain_entity_id = eid
        state.grain = (entity.grain_description if entity else None) or "one row per record"
        return

    # fallback: no subject tagged (older path) — ask the LLM which entity is the grain
    result = await llm_client.run_structured(
        _render(session, state), output_schema=GrainResult, instructions=_INSTRUCTIONS
    )
    valid_ids = {e.entity_id for e in state.entities}
    if result.grain_entity_id in valid_ids:
        state.grain_entity_id = result.grain_entity_id
    else:
        state.grain_entity_id = state.entities[0].entity_id
        state.add_assumption("Grain entity defaulted to the primary matched table.")
    state.grain = result.grain
