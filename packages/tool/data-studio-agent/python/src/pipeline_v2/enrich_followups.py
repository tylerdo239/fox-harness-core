"""9c — Follow-up questions (LLM, grounded in the semantic layer's UNUSED parts).

Suggests 2–3 natural next questions. The key to good suggestions is grounding them in data
that actually EXISTS but wasn't used in this query — related columns, other entities reachable
by a relationship, glossary concepts — so a suggestion like 'BMI by gender' only appears when a
gender column really exists. We show the model the used-vs-available schema and forbid
suggesting anything the schema can't answer.
"""

from typing import Any

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from src.database.models import BusinessGlossaryTerm, Entity, EntityColumn, EntityRelationship
from src.pipeline_v2.state import PipelineState
from src.services.llm_client import LLMClient

_INSTRUCTIONS = """\
# Task
Suggest **2–3** natural follow-up questions a user might ask next.

# CRITICAL — language
Write every follow-up question in the SAME language as the original question. The questions are
usually **Vietnamese** — if the original is Vietnamese, write the suggestions entirely in
Vietnamese. Never switch to English. **This overrides any default to English.**

# Rules
- **Ground every suggestion** in the "available but unused" schema shown — only suggest something
  the listed columns/entities/glossary can actually answer. Never suggest a question about data
  that isn't in the schema.
- Prefer questions that **extend** the current one: a different breakdown (by another dimension
  that exists), a correlation with a related measure, a filter on a related attribute.
- Keep each question short and specific. No preamble.
"""


class FollowUps(BaseModel):
    questions: list[str] = Field(
        default_factory=list,
        description="2–3 grounded follow-up questions, each in the same language as the original question (Vietnamese if it is Vietnamese).",
    )


async def generate_followups(
    session: Session,
    llm_client: LLMClient,
    state: PipelineState,
) -> FollowUps:
    used_entity_ids = set(state.target_entity_ids)
    prompt = _render(session, state, used_entity_ids)
    return await llm_client.run_structured(prompt, output_schema=FollowUps, instructions=_INSTRUCTIONS)


def _render(session: Session, state: PipelineState, used_entity_ids: set[int]) -> str:
    # Anchor language on the user's ORIGINAL wording (state.intent may be an English rephrase),
    # so the suggestions come back in the user's language.
    lines = [
        f"Original question (write suggestions in THIS language): {state.question}",
        f"Interpreted intent: {state.intent or state.question}",
        "",
    ]

    # columns on the entities already in play but NOT used in this query — cheap extensions
    used_col_ids = set(state.select_column_ids) | set(state.group_by_column_ids)
    used_col_ids |= {f.column_id for f in state.filters}
    for m in state.metrics:
        if m.expr_column_id:
            used_col_ids.add(m.expr_column_id)

    lines.append("Available columns on the current tables (unused ones are candidates for a new breakdown):")
    for eid in used_entity_ids:
        entity = session.get(Entity, eid)
        cols = session.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == eid,
                EntityColumn.is_exposed == True,  # noqa: E712
                EntityColumn.is_deprecated == False,  # noqa: E712
            )
        ).all()
        for c in cols:
            mark = " [used]" if c.id in used_col_ids else ""
            role = c.role.value if c.role else "?"
            lines.append(f"  [{entity.display_name}] {c.display_name} (role={role}){mark}")

    # related entities reachable by a relationship — candidates for a deeper question
    related = _related_entities(session, used_entity_ids)
    if related:
        lines.append("\nRelated tables reachable from the current ones (for deeper questions):")
        for e in related:
            lines.append(f"  {e.display_name}: {e.description or e.grain_description or ''}")

    # glossary concepts not yet used
    glossary = session.exec(
        select(BusinessGlossaryTerm).where(BusinessGlossaryTerm.sql_expression.is_not(None))
    ).all()
    used_terms = {r.term for r in state.business_rules}
    unused = [g for g in glossary if g.term not in used_terms]
    if unused:
        lines.append("\nBusiness concepts available (not used here):")
        for g in unused:
            lines.append(f"  {g.term}: {g.definition_text[:100]}")

    lines.append("\nSuggest 2–3 follow-up questions grounded ONLY in the schema above.")
    return "\n".join(lines)


def _related_entities(session: Session, used_entity_ids: set[int]) -> list[Entity]:
    if not used_entity_ids:
        return []
    rels = session.exec(
        select(EntityRelationship).where(
            (EntityRelationship.from_entity_id.in_(used_entity_ids))
            | (EntityRelationship.to_entity_id.in_(used_entity_ids))
        )
    ).all()
    related_ids: set[int] = set()
    for r in rels:
        other = r.to_entity_id if r.from_entity_id in used_entity_ids else r.from_entity_id
        if other not in used_entity_ids:
            related_ids.add(other)
    if not related_ids:
        return []
    return list(session.exec(select(Entity).where(Entity.id.in_(related_ids))).all())
