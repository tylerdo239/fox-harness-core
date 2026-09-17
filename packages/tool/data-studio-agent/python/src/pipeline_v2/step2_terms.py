"""Step 2 — Resolve business terms (glossary-first, mostly deterministic).

Design principle: glossary dẫn dắt, metadata xác minh. A detected term is matched to a
glossary entry first; if it hits, its curated sql_expression is reused VERBATIM (never
re-assembled from sample_values). We then verify the columns the expression references
actually exist — a stale glossary must fail loudly, not silently generate wrong SQL.

The 'is this term actually operative for this question' judgment reuses v1's taxonomy
check_scope, so we don't re-implement the operative-vs-related decision.
"""

import re

from sqlmodel import Session, select

from src.database.models import BusinessGlossaryTerm, Entity, EntityColumn
from src.pipeline_v2.state import BusinessRule, EntityMatch, PipelineState
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.taxonomy import check_scope
from src.services.vector_store import VectorStore

TOP_K_GLOSSARY = 5

# crude identifier extractor: catches bare col names and table.col / config->>'x' style refs
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


async def run_step2(
    session: Session,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    state: PipelineState,
) -> None:
    query_text = state.intent or state.question
    query_embedding = await embedding_client.embed_query(query_text)
    hits = vector_store.query(
        "business_glossary", query_embedding, n_results=TOP_K_GLOSSARY, query_text=query_text
    )
    embedding_ids = set(_extract_term_ids(hits))

    # Lexical match: glossary terms the question NAMES verbatim (e.g. 'intent node'). These are
    # treated as operative WITHOUT the LLM scope check — the user literally named the business
    # concept, so it's not a judgment call, and check_scope is itself flaky on a small model.
    # This is the key robustness fix: a named term must never silently drop (which would count
    # the wrong thing). Only embedding-retrieved-but-not-named terms need the operative judgment.
    lexical_ids = _lexical_glossary_ids(session, state)

    embedding_only = sorted(embedding_ids - lexical_ids)
    operative_ids = set(lexical_ids)
    if embedding_only:
        operative_ids |= set(await check_scope(session, llm_client, query_text, embedding_only))

    if not operative_ids:
        return

    terms = session.exec(
        select(BusinessGlossaryTerm).where(BusinessGlossaryTerm.id.in_(sorted(operative_ids)))
    ).all()

    known_columns = _known_physical_names(session, state)

    for term in terms:
        if not term.sql_expression:
            continue
        verified = _verify_expression_columns(term.sql_expression, known_columns)
        applies_to = _guess_applies_to(session, term, state)
        rule = BusinessRule(
            term=term.term,
            glossary_id=term.id,
            applies_to_entity_id=applies_to,
            filter_sql=term.sql_expression,
            verified=verified,
        )
        state.business_rules.append(rule)
        if not verified:
            state.add_assumption(
                f"Glossary term '{term.term}' references a column not found among the selected "
                f"tables — its filter may be stale. Applied as-is; verify the glossary."
            )
        if applies_to is not None:
            _ensure_entity_selected(session, state, applies_to, term.term)


def _ensure_entity_selected(session: Session, state: PipelineState, entity_id: int, term: str) -> None:
    """Force-add the entity a glossary rule lives on, if schema-linking missed it. Registers a
    real EntityMatch (so grain/select/join steps all see it) plus target_entity_ids. Without
    this, a rule like 'intent node' on workflow_nodes silently drops when step 1 forgot that
    table — the query then counts ALL nodes instead of intent nodes, a wrong number that still
    'runs'."""
    state.target_entity_ids.add(entity_id)
    if any(e.entity_id == entity_id for e in state.entities):
        return
    entity = session.get(Entity, entity_id)
    if entity is None:
        return
    state.entities.append(
        EntityMatch(term=term, entity_id=entity_id, table_physical_path=entity.physical_path, confidence=1.0)
    )
    state.add_assumption(
        f"Added table '{entity.display_name}' because glossary term '{term}' requires it "
        f"(schema-linking had not selected it)."
    )


def _extract_term_ids(hits: dict) -> list[int]:
    metadatas = hits.get("metadatas", [[]])[0]
    return [m["term_id"] for m in metadatas if "term_id" in m]


def _lexical_glossary_ids(session: Session, state: PipelineState) -> set[int]:
    """Glossary terms whose name or a synonym literally occurs in the question or a detected
    noun phrase. Cheap, deterministic, and immune to embedding flakiness for named concepts."""
    haystack = " ".join([state.question.lower(), *(t.lower() for t in state.detected_terms)])
    matched: set[int] = set()
    for term in session.exec(select(BusinessGlossaryTerm)).all():
        names = [term.term, *term.synonyms]
        if any(n and n.lower() in haystack for n in names):
            if term.id is not None:
                matched.add(term.id)
    return matched


def _known_physical_names(session: Session, state: PipelineState) -> set[str]:
    """Physical column names across all currently-selected entities, lowercased.
    Used to check a glossary expression doesn't reference a vanished column."""
    entity_ids = list(state.target_entity_ids or set(state.entity_ids()))
    if not entity_ids:
        return set()
    cols = session.exec(
        select(EntityColumn.physical_name).where(EntityColumn.entity_id.in_(entity_ids))
    ).all()
    return {c.lower() for c in cols}


def _verify_expression_columns(sql_expression: str, known_columns: set[str]) -> bool:
    """True if every plausible column identifier in the expression exists in a selected table.
    Conservative: SQL keywords and string literals are ignored, and if we can't find ANY
    column-looking token we treat it as verified (nothing to contradict)."""
    # strip quoted string literals so their contents aren't mistaken for identifiers
    stripped = re.sub(r"'[^']*'", "", sql_expression)
    tokens = {t.lower() for t in _IDENT_RE.findall(stripped)}
    candidates = tokens - _SQL_KEYWORDS
    column_like = {t for t in candidates if t in known_columns or "_" in t or t.endswith("id")}
    if not column_like:
        return True
    referenced = {t for t in column_like if t in known_columns}
    # verified only if at least one referenced token resolves and none obviously dangle;
    # we accept partial (JSON-path fragments like handler_type won't be physical columns)
    return bool(referenced) or column_like.issubset(_JSON_PATH_TOLERATED)


def _guess_applies_to(session: Session, term: BusinessGlossaryTerm, state: PipelineState) -> int | None:
    """Which entity does this term's filter live on? Match the term's referenced physical
    column names against EVERY exposed entity's columns — not just already-selected ones.

    Searching all entities (not only selected) is deliberate: it lets a glossary rule DISCOVER
    the entity it needs even when a flaky schema-linking step forgot to select it. The caller
    then force-adds that entity, guaranteeing the join target for the rule's filter is present.
    Falls back to None (treat as a global filter) only when nothing matches."""
    tokens = {t.lower() for t in _IDENT_RE.findall(term.sql_expression or "")}
    all_entities = session.exec(
        select(Entity).where(
            Entity.is_exposed == True,  # noqa: E712
            Entity.is_deprecated == False,  # noqa: E712
        )
    ).all()
    best: tuple[int, int] | None = None
    for entity in all_entities:
        if entity.id is None:
            continue
        names = {
            c.lower()
            for c in session.exec(
                select(EntityColumn.physical_name).where(EntityColumn.entity_id == entity.id)
            ).all()
        }
        overlap = len(tokens & names)
        # prefer an already-selected entity on ties, so we don't needlessly pull in a new table
        weight = overlap * 10 + (1 if entity.id in state.target_entity_ids else 0)
        if overlap and (best is None or weight > best[1]):
            best = (entity.id, weight)
    return best[0] if best else None


_SQL_KEYWORDS = {
    "and", "or", "not", "in", "is", "null", "true", "false", "like", "between",
    "select", "from", "where", "as", "on", "case", "when", "then", "else", "end",
    "cast", "coalesce", "count", "sum", "avg", "min", "max", "distinct",
}
# JSON path fragments (config->>'handler_type') aren't physical columns; tolerate them.
_JSON_PATH_TOLERATED: set[str] = set()
