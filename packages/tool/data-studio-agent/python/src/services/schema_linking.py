from dataclasses import dataclass, field

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from src.database.models import (
    BusinessGlossaryTerm,
    Entity,
    EntityColumn,
    EntityRelationship,
    RelationshipColumnPair,
)
from src.database.models.enums import ColumnRole, SemanticType
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.vector_store import VectorStore

TOP_K_ENTITIES = 6
TOP_K_GLOSSARY = 3

_INSTRUCTIONS = [
    "You are a Data Engineer choosing which tables and columns are needed to answer a question.",
    "Only pick from the candidates provided below — never invent table or column names.",
    "Pick the smallest set of entities and columns that can answer the question.",
    "Include a glossary term only if it is directly relevant to the question's wording.",
    "If the question asks 'which X' or wants results grouped/labeled by X (e.g. 'which workflow "
    "has the most...'), and X is a separate entity from the one holding the measured data, you "
    "MUST include X's entity_id and its name/label column — even if the question never names "
    "one of X's columns directly. Without it you can only show an internal id, not the answer "
    "the user actually wants.",
    "You do NOT need to select join key columns yourself — joins between the entities you pick "
    "are built automatically from curated relationships, regardless of which columns you list. "
    "The 'Join keys' list below is for your own understanding of how entities connect, not a "
    "checklist of columns to include.",
]


@dataclass
class CandidateColumn:
    id: int
    display_name: str
    role: str | None
    semantic_type: str | None


@dataclass
class CandidateEntity:
    id: int
    display_name: str
    description: str | None
    grain_description: str | None
    columns: list[CandidateColumn] = field(default_factory=list)


@dataclass
class CandidateGlossaryTerm:
    id: int
    term: str
    definition_text: str
    sql_expression: str | None


@dataclass
class CandidateJoinKey:
    from_entity_id: int
    from_column_id: int
    from_column_name: str
    to_entity_id: int
    to_column_id: int
    to_column_name: str


@dataclass
class RetrievalResult:
    entities: list[CandidateEntity]
    glossary_terms: list[CandidateGlossaryTerm]
    join_keys: list[CandidateJoinKey] = field(default_factory=list)


class SchemaSelection(BaseModel):
    entity_ids: list[int] = Field(description="IDs of entities needed to answer the question")
    column_ids: list[int] = Field(description="IDs of the specific columns needed")
    glossary_term_ids: list[int] = Field(
        default_factory=list, description="IDs of glossary terms that apply to this question"
    )


PER_TERM_K = 4  # how many entity hits to keep per detected term


async def retrieve_candidates(
    session: Session,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    question: str,
    top_k_entities: int = TOP_K_ENTITIES,
    top_k_glossary: int = TOP_K_GLOSSARY,
    keyword_text: str | None = None,
    terms: list[str] | None = None,
) -> RetrievalResult:
    """Code-only retrieval.

    Entities are retrieved with ONE hybrid search PER detected term, not one concatenated query.
    Concatenating ('workflow conversation') makes the terms compete inside a single ranked top-k:
    'conversation' plus every 'workflow_*' prefix-sibling filled the 6 slots and pushed the exact
    'workflows' table out of the candidate set entirely — so step 1 tagged 'workflow_nodes' as the
    subject and the whole query grounded to the wrong grain. Searching each term separately gives
    every named entity its own top-k, so the exact-name table always surfaces. Results are unioned
    (best rank per entity wins). A final question-level pass adds semantic recall for entities no
    bare term named.

    Governance filtering already happened at index time (only exposed/non-deprecated rows were
    indexed), so anything returned here is already safe to show the model."""
    query_embedding = await embedding_client.embed_query(question)

    # Prefer per-term search; fall back to the legacy single keyword_text (or the question) when
    # no terms are supplied, so older callers keep working.
    search_terms = [t.strip() for t in (terms or []) if t.strip()]
    if not search_terms and keyword_text:
        search_terms = [keyword_text]

    # entity_id -> best (lowest) distance seen across all per-term searches
    best: dict[int, float] = {}

    if search_terms:
        term_embeddings = await embedding_client.embed_documents(search_terms)
        for term, emb in zip(search_terms, term_embeddings, strict=True):
            hits = vector_store.query("entities", emb, n_results=PER_TERM_K, query_text=term)
            _merge_hits(best, hits)

    # question-level pass: semantic recall for entities no single term named (e.g. an implied
    # bridge table). Uses the question vector + full question text.
    q_hits = vector_store.query("entities", query_embedding, n_results=top_k_entities, query_text=question)
    _merge_hits(best, q_hits)

    # Exact-name boost: a term whose text IS an entity's name (modulo plural/underscore/spacing)
    # must lead — BM25 otherwise ranks prefix-siblings (workflow_edges) above the exact table
    # (workflows) for the bare term 'workflow', and the weak grounding model then mistags the
    # subject. Force every exact-name match to the front, ahead of any embedding-ranked hit.
    exact_ids = _exact_name_entity_ids(session, search_terms)
    for eid in exact_ids:
        best.setdefault(eid, 0.0)

    # order by best distance (ascending = closest first); exact-name matches carry distance -1 so
    # they sort ahead of everything. No artificial top-k cut — the union is already small and
    # every named entity earned its place.
    for eid in exact_ids:
        best[eid] = -1.0
    entity_ids = [eid for eid, _ in sorted(best.items(), key=lambda kv: kv[1])]

    glossary_hits = vector_store.query(
        "business_glossary", query_embedding, n_results=top_k_glossary, query_text=keyword_text or question
    )
    glossary_ids = _extract_ids(glossary_hits, "term_id")

    candidate_entities = _load_candidate_entities(session, entity_ids)
    candidate_glossary = _load_candidate_glossary(session, glossary_ids)
    join_keys = _load_join_keys(session, entity_ids)

    return RetrievalResult(entities=candidate_entities, glossary_terms=candidate_glossary, join_keys=join_keys)


def _merge_hits(best: dict[int, float], hits: dict) -> None:
    """Fold a query()'s hits into the best-distance map (keep the closest distance per entity)."""
    metadatas = hits.get("metadatas", [[]])[0]
    distances = hits.get("distances", [[]])[0]
    for meta, dist in zip(metadatas, distances, strict=False):
        eid = meta.get("entity_id")
        if eid is None:
            continue
        if eid not in best or dist < best[eid]:
            best[eid] = dist


def _normalize_name(s: str) -> str:
    """Fold a term or table name to a comparison key: lowercase, drop separators, singularize a
    trailing plural 's' so 'workflow' == 'workflows' == 'work_flows'."""
    key = "".join(ch for ch in s.lower() if ch.isalnum())
    if len(key) > 3 and key.endswith("s"):
        key = key[:-1]
    return key


def _exact_name_entity_ids(session: Session, terms: list[str]) -> list[int]:
    """Entity ids whose table name (last physical-path segment) or display name exactly matches a
    detected term after normalization. Preserves term order so the primary subject leads."""
    if not terms:
        return []
    entities = session.exec(select(Entity)).all()
    by_key: dict[str, int] = {}
    for e in entities:
        table = e.physical_path.split(".")[-1] if e.physical_path else ""
        for name in (table, e.display_name or ""):
            k = _normalize_name(name)
            if k:
                by_key.setdefault(k, e.id)
    out: list[int] = []
    for t in terms:
        eid = by_key.get(_normalize_name(t))
        if eid is not None and eid not in out:
            out.append(eid)
    return out


def _load_join_keys(session: Session, entity_ids: list[int]) -> list[CandidateJoinKey]:
    """Surfaces the exact join key column pair for every curated relationship between two
    candidate entities, so the model is told the join key instead of having to infer it from
    column naming — inference is unreliable, especially for a smaller model, when both sides
    of a join happen to be named the same thing (e.g. workflow_id on both sides) or when the
    real key isn't the most obviously-named column (e.g. node_id, not id)."""
    if len(entity_ids) < 2:
        return []

    entity_id_set = set(entity_ids)
    relationships = session.exec(
        select(EntityRelationship).where(
            EntityRelationship.from_entity_id.in_(entity_id_set),
            EntityRelationship.to_entity_id.in_(entity_id_set),
        )
    ).all()
    if not relationships:
        return []

    rel_ids = [r.id for r in relationships]
    pairs = session.exec(
        select(RelationshipColumnPair).where(RelationshipColumnPair.relationship_id.in_(rel_ids))
    ).all()
    if not pairs:
        return []

    rels_by_id = {r.id: r for r in relationships}
    col_ids = {p.from_column_id for p in pairs} | {p.to_column_id for p in pairs}
    cols_by_id = {c.id: c for c in session.exec(select(EntityColumn).where(EntityColumn.id.in_(col_ids))).all()}

    join_keys = []
    for pair in pairs:
        rel = rels_by_id.get(pair.relationship_id)
        from_col = cols_by_id.get(pair.from_column_id)
        to_col = cols_by_id.get(pair.to_column_id)
        if rel is None or from_col is None or to_col is None:
            continue
        join_keys.append(
            CandidateJoinKey(
                from_entity_id=rel.from_entity_id,
                from_column_id=from_col.id,
                from_column_name=from_col.physical_name,
                to_entity_id=rel.to_entity_id,
                to_column_id=to_col.id,
                to_column_name=to_col.physical_name,
            )
        )
    return join_keys


def _extract_ids(chroma_result: dict, metadata_key: str) -> list[int]:
    metadatas = chroma_result.get("metadatas", [[]])[0]
    return [m[metadata_key] for m in metadatas if metadata_key in m]


def _load_candidate_entities(session: Session, entity_ids: list[int]) -> list[CandidateEntity]:
    if not entity_ids:
        return []

    entities = session.exec(select(Entity).where(Entity.id.in_(entity_ids))).all()
    entities_by_id = {e.id: e for e in entities}

    result = []
    for eid in entity_ids:
        entity = entities_by_id.get(eid)
        if entity is None:
            continue

        columns = session.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == eid,
                EntityColumn.is_exposed == True,  # noqa: E712
                EntityColumn.is_deprecated == False,  # noqa: E712
            )
        ).all()

        result.append(
            CandidateEntity(
                id=entity.id,
                display_name=entity.display_name,
                description=entity.description,
                grain_description=entity.grain_description,
                columns=[
                    CandidateColumn(
                        id=c.id,
                        display_name=c.display_name,
                        role=c.role.value if c.role else None,
                        semantic_type=c.semantic_type.value if c.semantic_type else None,
                    )
                    for c in columns
                ],
            )
        )

    return result


def _load_candidate_glossary(session: Session, term_ids: list[int]) -> list[CandidateGlossaryTerm]:
    if not term_ids:
        return []

    terms = session.exec(select(BusinessGlossaryTerm).where(BusinessGlossaryTerm.id.in_(term_ids))).all()
    terms_by_id = {t.id: t for t in terms}

    return [
        CandidateGlossaryTerm(
            id=terms_by_id[tid].id,
            term=terms_by_id[tid].term,
            definition_text=terms_by_id[tid].definition_text,
            # the candidate shape carries a single string for display; join the term's predicates
            sql_expression=" AND ".join(terms_by_id[tid].sql_expressions or []) or None,
        )
        for tid in term_ids
        if tid in terms_by_id
    ]


def _render_candidates(retrieval: RetrievalResult) -> str:
    lines = ["Candidate entities:"]
    for entity in retrieval.entities:
        lines.append(f"\n[entity_id={entity.id}] {entity.display_name}")
        if entity.description:
            lines.append(f"  description: {entity.description}")
        if entity.grain_description:
            lines.append(f"  grain: {entity.grain_description}")
        lines.append("  columns:")
        for col in entity.columns:
            role = col.role or "?"
            sem = col.semantic_type or "?"
            lines.append(f"    [column_id={col.id}] {col.display_name} (role={role}, type={sem})")

    if retrieval.join_keys:
        lines.append(
            "\nJoin keys (the exact column pair to use — do not guess a different column):"
        )
        for jk in retrieval.join_keys:
            lines.append(
                f"[entity_id={jk.from_entity_id}] column_id={jk.from_column_id} "
                f"('{jk.from_column_name}') = [entity_id={jk.to_entity_id}] "
                f"column_id={jk.to_column_id} ('{jk.to_column_name}')"
            )

    if retrieval.glossary_terms:
        lines.append("\nCandidate glossary terms:")
        for term in retrieval.glossary_terms:
            lines.append(f"[glossary_id={term.id}] {term.term}: {term.definition_text}")

    return "\n".join(lines)


async def select_schema(
    llm_client: LLMClient, question: str, retrieval: RetrievalResult
) -> SchemaSelection:
    """LLM-select phase: the model only picks from pre-retrieved candidates, never
    invents identifiers. Code already narrowed the field via vector search."""
    if not retrieval.entities:
        return SchemaSelection(entity_ids=[], column_ids=[], glossary_term_ids=[])

    prompt = (
        f"{_render_candidates(retrieval)}\n\n"
        f"Question: {question}\n\n"
        f"Select the entity_ids, column_ids, and (if relevant) glossary_term_ids needed to answer this."
    )

    return await llm_client.run_structured(
        prompt, output_schema=SchemaSelection, instructions=_INSTRUCTIONS
    )


def backfill_related_entities(session: Session, question: str, selection: SchemaSelection) -> SchemaSelection:
    """Code-level safety net for a recurring LLM miss: the question asks 'which X' (e.g.
    'which workflow has the most...') but the model only selects the entity holding the
    measured data, forgetting the related entity needed to label/group the answer — even
    though a plain instruction says to include it. Rather than rely solely on the model
    remembering, walk the selected entities' curated relationships and auto-add any related
    entity whose name is named in the question but wasn't selected, plus a best-guess label
    column for it. Entities/columns already selected are left untouched."""
    if not selection.entity_ids:
        return selection

    question_lower = question.lower()
    selected_entity_ids = set(selection.entity_ids)

    relationships = session.exec(
        select(EntityRelationship).where(
            (EntityRelationship.from_entity_id.in_(selected_entity_ids))
            | (EntityRelationship.to_entity_id.in_(selected_entity_ids))
        )
    ).all()

    candidate_entity_ids = set()
    for rel in relationships:
        other_id = (
            rel.to_entity_id if rel.from_entity_id in selected_entity_ids else rel.from_entity_id
        )
        if other_id not in selected_entity_ids:
            candidate_entity_ids.add(other_id)

    if not candidate_entity_ids:
        return selection

    candidates = session.exec(select(Entity).where(Entity.id.in_(candidate_entity_ids))).all()

    new_entity_ids: list[int] = []
    new_column_ids: list[int] = []
    for entity in candidates:
        names_to_check = [entity.display_name, *entity.synonyms]
        if not any(name.lower() in question_lower for name in names_to_check if name):
            continue

        new_entity_ids.append(entity.id)
        label_column = _best_label_column(session, entity.id)
        if label_column is not None:
            new_column_ids.append(label_column)

    if not new_entity_ids:
        return selection

    return selection.model_copy(
        update={
            "entity_ids": [*selection.entity_ids, *new_entity_ids],
            "column_ids": [*selection.column_ids, *new_column_ids],
        }
    )



def _best_label_column(session: Session, entity_id: int) -> int | None:
    columns = session.exec(
        select(EntityColumn)
        .where(
            EntityColumn.entity_id == entity_id,
            EntityColumn.is_exposed == True,  # noqa: E712
            EntityColumn.is_deprecated == False,  # noqa: E712
            EntityColumn.role != ColumnRole.KEY,
            EntityColumn.semantic_type == SemanticType.TEXT,
        )
        .order_by(EntityColumn.ordinal)
    ).first()
    return columns.id if columns else None
