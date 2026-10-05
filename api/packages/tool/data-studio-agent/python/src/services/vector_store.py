from typing import Any

import chromadb

from src.settings import Settings

COLLECTION_NAMES = ("entities", "entity_columns", "metrics", "verified_queries", "business_glossary")


class VectorStore:
    def __init__(self, settings: Settings) -> None:
        self._client = chromadb.PersistentClient(path=settings.chroma_persist_dir)

    def _collection(self, name: str):
        return self._client.get_or_create_collection(name=name)

    def upsert(
        self,
        collection_name: str,
        ids: list[str],
        documents: list[str],
        embeddings: list[list[float]],
        metadatas: list[dict[str, Any]],
    ) -> None:
        if not ids:
            return
        self._collection(collection_name).upsert(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas,
        )

    def delete(self, collection_name: str, ids: list[str]) -> None:
        if not ids:
            return
        self._collection(collection_name).delete(ids=ids)

    def query(
        self,
        collection_name: str,
        query_embedding: list[float],
        n_results: int = 8,
        where: dict[str, Any] | None = None,
        query_text: str = "",  # accepted for interface parity with MeiliStore; Chroma ignores it
    ) -> dict[str, Any]:
        return self._collection(collection_name).query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=where,
            include=["documents", "metadatas", "distances"],
        )

    def count(self, collection_name: str) -> int:
        return self._collection(collection_name).count()
