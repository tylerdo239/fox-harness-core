from pydantic import BaseModel, Field
from sqlmodel import Session, select

from src.database.models import BusinessGlossaryTerm
from src.services.llm_client import LLMClient

_INSTRUCTIONS = """\
# Role
You are a Data Engineer **checking scope** — not writing SQL, not picking columns.

# Task
For each candidate glossary term, decide whether it is the **operative** definition this question
needs (the term the question is actually asking about) versus merely topically related or
coincidentally similar wording.

# Rules
- Mark a term **operative only if** answering the question correctly REQUIRES using that term's
  definition (and its `sql_expression`, if it has one) rather than a plain column filter.
- If the question could equally be answered WITHOUT this term, mark it **not operative**.
- **Be conservative.** Marking a term operative forces every plan to route through its
  `sql_expression` instead of guessing a plain filter — so only do this when the question's own
  wording clearly names or implies this exact business concept.
"""


class TermScope(BaseModel):
    glossary_id: int
    is_operative: bool = Field(
        description="True if this question requires this term's own definition/sql_expression "
        "to answer correctly, not just a loosely related concept."
    )
    reason: str = Field(description="One short sentence explaining the call.")


class ScopeCheck(BaseModel):
    terms: list[TermScope] = Field(default_factory=list)


async def check_scope(
    session: Session, llm_client: LLMClient, question: str, glossary_term_ids: list[int]
) -> list[int]:
    """Step between schema_linking and plan: schema_linking already decided a glossary term
    is 'relevant enough to show as context' — this decides the stricter question of whether
    it's the operative definition, i.e. whether the plan step is FORBIDDEN from answering the
    same concept with a guessed plain filter instead. Only terms with a sql_expression can be
    mandatory — a term without one is a definition to read, not a rule to enforce. Returns the
    subset of glossary_term_ids that must be used via glossary_sql_expression."""
    if not glossary_term_ids:
        return []

    terms = session.exec(
        select(BusinessGlossaryTerm).where(
            BusinessGlossaryTerm.id.in_(glossary_term_ids),
            BusinessGlossaryTerm.sql_expression.is_not(None),
        )
    ).all()
    if not terms:
        return []

    prompt = _render_prompt(question, terms)
    result = await llm_client.run_structured(prompt, output_schema=ScopeCheck, instructions=_INSTRUCTIONS)
    return [t.glossary_id for t in result.terms if t.is_operative]


def _render_prompt(question: str, terms: list[BusinessGlossaryTerm]) -> str:
    lines = ["Candidate glossary terms (already retrieved as topically relevant):"]
    for t in terms:
        synonyms = f" (synonyms: {', '.join(t.synonyms)})" if t.synonyms else ""
        lines.append(f"[glossary_id={t.id}] '{t.term}'{synonyms}: {t.definition_text}")
        lines.append(f"  sql_expression: {t.sql_expression}")

    lines.append(f"\nQuestion: {question}")
    lines.append(
        "\nFor each glossary_id above, decide is_operative: does answering this question "
        "correctly require this term's own definition, or is it just tangentially related?"
    )
    return "\n".join(lines)
