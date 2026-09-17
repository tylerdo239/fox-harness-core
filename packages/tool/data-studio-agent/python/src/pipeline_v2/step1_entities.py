"""Step 1 — Ground entities → tables (LLM + retrieval).

Reuses v1's retrieval (embed question, Chroma search entities). The LLM then maps each
detected noun phrase to a candidate entity_id with a confidence, choosing only from the
retrieved candidates — never inventing a table. Low confidence or a tie surfaces a
ClarificationNeeded rather than a silent guess.
"""

from pydantic import BaseModel, Field
from sqlmodel import Session

from src.database.models import Entity
from src.pipeline_v2.state import ClarificationNeeded, EntityMatch, PipelineState
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.schema_linking import RetrievalResult, retrieve_candidates
from src.services.vector_store import VectorStore

CONFIDENCE_FLOOR = 0.5

_INSTRUCTIONS = """\
# Role
You map each noun phrase from the question to **exactly one** candidate entity below, and tag the
ROLE each entity plays in the answer.

# Roles
- **subject** — the entity the answer is ABOUT: what one result row represents. Exactly ONE
  entity is the subject. For "which A has the most B" / "A nào có nhiều B nhất", the answer names
  an A, so **A is the subject** (not B). For "list the X", X is the subject. For "how many X", X
  is the subject.
- **measure** — an entity whose rows are COUNTED/aggregated, or that's only joined/filtered. In
  "which A has the most B", **B is a measure** (it's counted, not the subject).

# Rules
- Only choose from the candidate `entity_id`s provided — **never invent one**.
- Map EVERY noun phrase that names a data entity — you must include BOTH the subject and any
  measured entity. Dropping the subject is a common mistake: without it the query can only count
  the measure overall and can never identify which subject wins.
- Exactly one assignment must have role="subject". Tag the rest "measure".
- Prefer the concrete business entity the user means over a config/detail/sub table that merely
  shares a similar name.
- Give a `confidence` in `[0, 1]`. Use a **low** confidence (`< 0.5`) when no candidate clearly
  fits, or when two candidates fit equally well — do not force a pick you are unsure of.
- A noun phrase that names a business **concept** rather than a table (e.g. `intent node` when
  there is only a generic `nodes` table) should still map to the table that physically holds it —
  the concept's filter is handled elsewhere.
"""


class EntityAssignment(BaseModel):
    term: str
    entity_id: int
    role: str = Field(default="measure", description="'subject' (answer is about it) or 'measure' (counted/joined)")
    confidence: float = Field(ge=0.0, le=1.0)


class EntityGrounding(BaseModel):
    assignments: list[EntityAssignment] = Field(default_factory=list)


def _render_candidates(retrieval: RetrievalResult, terms: list[str]) -> str:
    lines = ["Candidate entities (choose entity_id from these only):"]
    for e in retrieval.entities:
        desc = f" — {e.description}" if e.description else ""
        lines.append(f"[entity_id={e.id}] {e.display_name}{desc}")
    lines.append("\nNoun phrases to map: " + ", ".join(terms))
    return "\n".join(lines)


async def run_step1(
    session: Session,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    state: PipelineState,
) -> None:
    # Hybrid retrieval: the VECTOR side uses the full question (semantic context), but the KEYWORD
    # side uses just the detected entity nouns (e.g. 'agent workflow') — NOT the full sentence.
    # Filler words ('tìm', 'có', 'nhất') in the sentence dilute the keyword match and push the
    # answer's subject entity below top-k (e.g. 'tìm agent có nhiều workflow nhất' buried the
    # agents table); the bare nouns lift every named entity into the candidate set.
    # search each detected noun SEPARATELY (not concatenated) — a single joined keyword query lets
    # sibling tables fill the top-k and starve the exact-name entity (see retrieve_candidates).
    retrieval = await retrieve_candidates(
        session, embedding_client, vector_store, state.question, terms=state.detected_terms or None
    )

    if not retrieval.entities:
        state.clarifications.append(
            ClarificationNeeded(slot="entities", question="No matching tables were found for this question.")
        )
        return

    valid_ids = {e.id for e in retrieval.entities}

    terms = state.detected_terms or [state.question]
    # Show the ORIGINAL question (not the intent rephrase, which can shift emphasis onto the
    # measured entity) so the model can see which entity the answer is ABOUT — without the
    # question it only sees a bag of noun phrases and mis-tags the subject.
    prompt = f"{_render_candidates(retrieval, terms)}\n\nQuestion: {state.question}"
    grounding = await llm_client.run_structured(
        prompt, output_schema=EntityGrounding, instructions=_INSTRUCTIONS
    )

    seen: set[int] = set()
    low_confidence_terms: list[str] = []
    subject_entity_id: int | None = None
    for a in grounding.assignments:
        if a.entity_id not in valid_ids or a.entity_id in seen:
            continue
        if a.confidence < CONFIDENCE_FLOOR:
            # A sub-floor assignment is usually a phantom term — a display word like 'tên'/'name'
            # or 'id' the model tried to map to a table. Drop it (the select ladder handles
            # display columns); do NOT abort the whole query over it. We only clarify below if
            # NOTHING resolved at all.
            low_confidence_terms.append(a.term)
            continue
        seen.add(a.entity_id)
        if a.role == "subject" and subject_entity_id is None:
            subject_entity_id = a.entity_id
        # candidate objects don't carry physical_path; look it up lazily from the DB entity
        entity = session.get(Entity, a.entity_id)
        state.entities.append(
            EntityMatch(
                term=a.term,
                entity_id=a.entity_id,
                table_physical_path=entity.physical_path if entity else "",
                confidence=a.confidence,
            )
        )

    state.target_entity_ids.update(e.entity_id for e in state.entities)

    # the subject entity — what the answer is about — is the grain. Setting it here (from the
    # role tag) means the answer's subject is guaranteed selected AND becomes the grouping level,
    # so a 'which A has most B' question can't collapse to a flat count of B. step3 keeps this.
    if subject_entity_id is not None:
        state.grain_entity_id = subject_entity_id

    if low_confidence_terms and state.entities:
        state.add_assumption(
            "Ignored terms that didn't clearly name a table: "
            + ", ".join(f"'{t}'" for t in low_confidence_terms)
        )

    # Clarify only when the question mapped to NO table at all — a single unmatched phantom
    # term alongside good matches must not discard an otherwise-valid query.
    if not state.entities:
        state.clarifications.append(
            ClarificationNeeded(slot="entities", question="I couldn't map the question to any table.")
        )
