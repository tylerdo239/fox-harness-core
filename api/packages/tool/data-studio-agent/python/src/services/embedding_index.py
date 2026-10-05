from typing import Any

from src.crud_mongo import business_glossary as glossary_crud
from src.security import role as role_mod
from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.crud_mongo import metric as metric_crud
from src.crud_mongo import verified_query as verified_query_crud
from src.database.mongodb import AttrDatabase, AttrDict
from src.services.embedding_client import EmbeddingClient
from src.services.vector_store import VectorStore

_BATCH_SIZE = 64


def entity_embed_text(entity: AttrDict) -> str:
    parts = [entity.display_name]
    if entity.description:
        parts.append(entity.description)
    if entity.synonyms:
        parts.append(" ".join(entity.synonyms))
    if entity.grain_description:
        parts.append(entity.grain_description)
    return " | ".join(parts)


def entity_column_embed_text(column: AttrDict) -> str:
    parts = [column.display_name]
    if column.description:
        parts.append(column.description)
    if column.synonyms:
        parts.append(" ".join(column.synonyms))
    return " | ".join(parts)


def metric_embed_text(metric: AttrDict) -> str:
    parts = [metric.name]
    if metric.description:
        parts.append(metric.description)
    if metric.synonyms:
        parts.append(" ".join(metric.synonyms))
    if metric.sample_nl_questions:
        parts.append(" ".join(metric.sample_nl_questions))
    return " | ".join(parts)


def verified_query_embed_text(query: AttrDict) -> str:
    return query.nl_question


def glossary_term_embed_text(term: AttrDict) -> str:
    parts = [term.term]
    if term.synonyms:
        parts.append(" ".join(term.synonyms))
    if term.definition_text:
        parts.append(term.definition_text)
    return " | ".join(parts)


async def _reindex_all_impl(
    db: AttrDatabase, embedding_client: EmbeddingClient, vector_store: VectorStore
) -> dict[str, int]:
    summary = {}

    # Meilisearch needs each index created + its userProvided embedder configured, and cleared,
    # before a fresh reindex. The Chroma store has no such methods, so guard by attribute — this
    # keeps reindex_all working whether it's handed a MeiliStore or (legacy) VectorStore.
    from src.services.meili_store import COLLECTION_NAMES as _MEILI_COLLECTIONS

    if hasattr(vector_store, "ensure_index"):
        for name in _MEILI_COLLECTIONS:
            vector_store.ensure_index(name)
            vector_store.clear(name)
        if hasattr(vector_store, "wait_for_tasks"):
            vector_store.wait_for_tasks()

    entities = entity_crud.list_exposed_active(db)
    for entity in entities:
        entity_crud.update(db, entity.id, embed_text=entity_embed_text(entity))

    summary["entities"] = await _index_rows(
        embedding_client,
        vector_store,
        collection_name="entities",
        rows=entities,
        text_fn=entity_embed_text,
        metadata_fn=lambda e: {"entity_id": e.id, "data_source_id": e.data_source_id},
    )

    columns = entity_column_crud.list_exposed_active(db)
    summary["entity_columns"] = await _index_rows(
        embedding_client,
        vector_store,
        collection_name="entity_columns",
        rows=columns,
        text_fn=entity_column_embed_text,
        metadata_fn=lambda c: {"column_id": c.id, "entity_id": c.entity_id},
    )

    metrics = metric_crud.list_all(db)
    summary["metrics"] = await _index_rows(
        embedding_client,
        vector_store,
        collection_name="metrics",
        rows=metrics,
        text_fn=metric_embed_text,
        metadata_fn=lambda m: {"metric_id": m.id, "is_verified": m.is_verified},
    )

    verified_queries = verified_query_crud.list_verified(db)
    summary["verified_queries"] = await _index_rows(
        embedding_client,
        vector_store,
        collection_name="verified_queries",
        rows=verified_queries,
        text_fn=verified_query_embed_text,
        metadata_fn=lambda q: {"query_id": q.id},
    )
    for query in verified_queries:
        verified_query_crud.update(db, query.id, embed_text=verified_query_embed_text(query))

    glossary_terms = glossary_crud.list_all(db)
    summary["business_glossary"] = await _index_rows(
        embedding_client,
        vector_store,
        collection_name="business_glossary",
        rows=glossary_terms,
        text_fn=glossary_term_embed_text,
        metadata_fn=lambda t: {"term_id": t.id},
    )

    # Meili indexes asynchronously — block until all documents are searchable before returning,
    # so a reindex immediately followed by a query sees the complete index.
    if hasattr(vector_store, "wait_for_tasks"):
        vector_store.wait_for_tasks(timeout_s=120)

    return summary


async def _index_rows(
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    collection_name: str,
    rows: list[Any],
    text_fn,
    metadata_fn,
) -> int:
    if not rows:
        return 0

    indexed = 0
    for batch_start in range(0, len(rows), _BATCH_SIZE):
        batch = rows[batch_start : batch_start + _BATCH_SIZE]
        texts = [text_fn(row) for row in batch]
        embeddings = await embedding_client.embed_documents(texts)

        vector_store.upsert(
            collection_name=collection_name,
            ids=[str(row.id) for row in batch],
            documents=texts,
            embeddings=embeddings,
            metadatas=[metadata_fn(row) for row in batch],
        )
        indexed += len(batch)

    return indexed


async def reindex_all(
    db: AttrDatabase, embedding_client: EmbeddingClient, vector_store: VectorStore
) -> dict[str, int]:
    """Admin operation: always sees the FULL catalog, whoever calls it (src/security/role.py)."""
    with role_mod.as_role(role_mod.ADMIN):
        return await _reindex_all_impl(db, embedding_client, vector_store)
