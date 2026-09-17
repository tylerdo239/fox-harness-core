"""Question decomposition into a DAG of sub-questions (pipeline_v2).

A complex question often bundles several distinct data questions — some independent (can run in
parallel), some depending on an earlier answer ("for the top workflow found, get its nodes"). This
step decides whether the question is multi-part and, if so, emits a small DAG:

    SubQuestion { id, question, depends_on: [ids] }

- `depends_on` empty  → independent, runs in parallel with its layer
- `depends_on` set     → runs after those complete; their result rows are injected into its
                          question text before it runs (see the executor)

A single-part question returns `is_multi_part=False` and one sub-question — the caller then just
runs the normal single pipeline, so simple queries pay no DAG overhead.
"""

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from src.database.models import Entity, Metric
from src.services.llm_client import LLMClient

MAX_SUB_QUESTIONS = 5

_INSTRUCTIONS = """\
# Role
You decompose a data question into a small DAG of atomic sub-questions.

# Decide first: is it multi-part?
- If the question is a SINGLE data question answerable by one query, set `is_multi_part = false`
  and return it unchanged as the only sub-question (no dependencies). Do NOT over-split.
- Only set `is_multi_part = true` when the question genuinely asks for **two or more distinct,
  SEPARATELY-REPORTED results** (e.g. "compare the number of workflows AND the number of
  conversations per agent" → two independent counts to show side by side).

# DO NOT split a filter-dependency — it is ONE query
- A "find X, then list/get X's Y" question (e.g. "find the agent with the most workflows, then
  list that agent's workflows"; "tìm agent có nhiều workflow nhất, rồi liệt kê workflow của agent
  đó") is a SINGLE query — SQL answers it directly with a subquery or join (list the Y whose
  parent is the top X). Do NOT split it: splitting forces passing a value between steps, which is
  fragile and often wrong. Keep it as one sub-question (is_multi_part=false).
- Rule of thumb: if a later part only needs an EARLIER part's VALUE to FILTER, it is NOT a
  separate result — keep the whole thing as one question.

# Building the DAG (only for genuinely separate results)
- Give each sub-question a short id (`q1`, `q2`, ...).
- Write each as a **natural-language question**, in the user's language — NOT as SQL.
- Each must be answerable by ONE query about one topic, and should stand on its own (a listing or
  a count that is a distinct result the user wants to see).
- **Dependencies** are only for combining/comparing already-computed results (e.g. q3 compares q1
  and q2's numbers) — NOT for passing a filter value. Set `depends_on` to the ids whose result q
  combines. Keep sub-questions short and in the same language.

# Constraints
- At most 5 sub-questions.
- Do not invent table/column names — use only the known topics provided as context.
- No cycles: a sub-question may only depend on ones defined before it.
"""


class SubQuestion(BaseModel):
    id: str = Field(description="Short id like 'q1'.")
    question: str = Field(description="Atomic sub-question, one SQL query, same language as original.")
    depends_on: list[str] = Field(
        default_factory=list,
        description="ids of sub-questions whose RESULT this one needs; empty = independent/parallel.",
    )


class DecompositionV2(BaseModel):
    is_multi_part: bool = Field(description="True only if the question asks for 2+ distinct things.")
    sub_questions: list[SubQuestion] = Field(default_factory=list, max_length=MAX_SUB_QUESTIONS)


def _names_context(session: Session) -> str:
    entities = session.exec(
        select(Entity).where(Entity.is_exposed == True, Entity.is_deprecated == False)  # noqa: E712
    ).all()
    metrics = session.exec(select(Metric)).all()
    lines = ["Known data topics (entities):"]
    for e in entities:
        names = ", ".join([e.display_name, *e.synonyms]) if e.synonyms else e.display_name
        lines.append(f"- {names}")
    if metrics:
        lines.append("\nKnown metrics:")
        for m in metrics:
            names = ", ".join([m.name, *m.synonyms]) if m.synonyms else m.name
            lines.append(f"- {names}")
    return "\n".join(lines)


async def decompose_v2(session: Session, llm_client: LLMClient, question: str) -> DecompositionV2:
    """Returns the decomposition. For a single-part question, is_multi_part is False and callers
    should just run the normal single pipeline on the original question."""
    prompt = f"{_names_context(session)}\n\nUser question: {question}"
    result = await llm_client.run_structured(
        prompt, output_schema=DecompositionV2, instructions=_INSTRUCTIONS
    )

    # sanitize: keep it single-part unless we truly got 2+ well-formed sub-questions
    subs = [s for s in result.sub_questions if s.question.strip()]
    if len(subs) < 2:
        return DecompositionV2(is_multi_part=False, sub_questions=[])
    subs = _prune_bad_dependencies(subs)
    return DecompositionV2(is_multi_part=True, sub_questions=subs)


def _prune_bad_dependencies(subs: list[SubQuestion]) -> list[SubQuestion]:
    """Drop any depends_on id that doesn't refer to an earlier sub-question — guards against the
    model naming a nonexistent or forward/self dependency, which would deadlock the executor."""
    seen: set[str] = set()
    cleaned: list[SubQuestion] = []
    for s in subs:
        valid_deps = [d for d in s.depends_on if d in seen and d != s.id]
        cleaned.append(SubQuestion(id=s.id, question=s.question, depends_on=valid_deps))
        seen.add(s.id)
    return cleaned
