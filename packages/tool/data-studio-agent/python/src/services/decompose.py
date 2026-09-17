from pydantic import BaseModel, Field
from sqlmodel import Session, select

from src.database.models import BusinessProcess, Entity, Metric
from src.services.llm_client import LLMClient

MAX_SUB_QUESTIONS = 5
MAX_FEW_SHOT_EXAMPLES = 3

_INSTRUCTIONS = [
    "You are a Data Engineer decomposing a business question into atomic sub-questions.",
    "Each sub-question must be answerable with a single SQL query against one topic.",
    "If the question is already atomic, return it unchanged as the only sub-question.",
    "Do not invent table or column names — only use the entity/metric names provided as context.",
    "Keep sub-questions short and in the same language as the original question.",
]


class Decomposition(BaseModel):
    sub_questions: list[str] = Field(
        description="Atomic sub-questions the original question breaks down into",
        max_length=MAX_SUB_QUESTIONS,
    )


def _build_names_context(session: Session) -> str:
    entities = session.exec(
        select(Entity).where(Entity.is_exposed == True, Entity.is_deprecated == False)  # noqa: E712
    ).all()
    metrics = session.exec(select(Metric)).all()

    lines = ["Known data topics (entities):"]
    for e in entities:
        names = ", ".join([e.display_name, *e.synonyms]) if e.synonyms else e.display_name
        lines.append(f"- {names}")

    lines.append("")
    lines.append("Known metrics:")
    for m in metrics:
        names = ", ".join([m.name, *m.synonyms]) if m.synonyms else m.name
        lines.append(f"- {names}")

    return "\n".join(lines)


def _build_few_shot(session: Session) -> str:
    processes = session.exec(select(BusinessProcess)).all()

    examples: list[str] = []
    for process in processes:
        examples.extend(process.sample_questions)
        if len(examples) >= MAX_FEW_SHOT_EXAMPLES:
            break

    if not examples:
        return ""

    lines = ["", "Example questions handled by this system:"]
    for q in examples[:MAX_FEW_SHOT_EXAMPLES]:
        lines.append(f"- {q}")
    return "\n".join(lines)


async def decompose_question(session: Session, llm_client: LLMClient, question: str) -> list[str]:
    names_context = _build_names_context(session)
    few_shot = _build_few_shot(session)

    prompt = (
        f"{names_context}"
        f"{few_shot}\n\n"
        f"User question: {question}\n\n"
        f"Break this into at most {MAX_SUB_QUESTIONS} atomic sub-questions."
    )

    result = await llm_client.run_structured(
        prompt, output_schema=Decomposition, instructions=_INSTRUCTIONS
    )

    sub_questions = [q.strip() for q in result.sub_questions if q.strip()]
    return sub_questions[:MAX_SUB_QUESTIONS] or [question]
