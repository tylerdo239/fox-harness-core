"""Meilisearch-backed hybrid retrieval, a drop-in replacement for the Chroma VectorStore.

Why hybrid: pure-vector search ranks by embedding similarity alone, which can bury an entity
whose literal name the question uses but whose description embeds closer to a sibling (the
'agents' question retrieved agent_model_configs but NOT the agents table). Meilisearch blends
keyword (BM25-style) and semantic ranking, so a literal term match lifts the right row.

We keep computing embeddings ourselves via EmbeddingClient and hand them to Meilisearch as a
`userProvided` embedder (`_vectors`), and pass both the query TEXT and its VECTOR at search time
— Meili fuses them by `semanticRatio`. query() returns a Chroma-shaped dict so existing callers
(which read result["metadatas"][0] / result["distances"][0]) work unchanged.
"""

from typing import Any

import httpx

from src.settings import Settings

# same logical collections as the Chroma store; each becomes one Meilisearch index
COLLECTION_NAMES = ("entities", "entity_columns", "metrics", "verified_queries", "business_glossary")

_EMBEDDER = "default"          # our single userProvided embedder name
_EMBED_DIM = 768              # nomic-embed-text-v1.5 dimension


class MeiliStore:
    def __init__(self, settings: Settings) -> None:
        self._base = settings.meilisearch_url.rstrip("/")
        self._semantic_ratio = settings.meilisearch_semantic_ratio
        headers = {"Content-Type": "application/json"}
        if settings.meilisearch_master_key:
            headers["Authorization"] = f"Bearer {settings.meilisearch_master_key}"
        self._client = httpx.Client(base_url=self._base, headers=headers, timeout=60)

    # ── index lifecycle ──

    def ensure_index(self, collection_name: str) -> None:
        """Create the index (if missing) and configure the userProvided embedder + searchable
        fields. Idempotent — safe to call before every reindex."""
        # create index with primary key 'id'
        self._client.post("/indexes", json={"uid": collection_name, "primaryKey": "id"})
        # configure the userProvided embedder so `_vectors.default` is accepted + used for hybrid
        self._client.patch(
            f"/indexes/{collection_name}/settings",
            json={
                "embedders": {
                    _EMBEDDER: {"source": "userProvided", "dimensions": _EMBED_DIM},
                },
                # only the human text is searchable by keyword; ids/metadata are filter-only
                "searchableAttributes": ["text"],
            },
        )

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
        docs = []
        for i, doc_id, text, emb, meta in zip(
            range(len(ids)), ids, documents, embeddings, metadatas, strict=True
        ):
            docs.append({
                "id": doc_id,
                "text": text,
                "_vectors": {_EMBEDDER: {"embeddings": emb, "regenerate": False}},
                **meta,
            })
        # Meili indexes asynchronously; callers that need immediate reads should wait on the task
        self._client.post(f"/indexes/{collection_name}/documents", json=docs)

    def delete(self, collection_name: str, ids: list[str]) -> None:
        if not ids:
            return
        self._client.post(f"/indexes/{collection_name}/documents/delete", json={"filter": None})  # noqa: E501

    def clear(self, collection_name: str) -> None:
        """Drop all documents in the index (used before a full reindex)."""
        self._client.delete(f"/indexes/{collection_name}/documents")

    # ── query ──

    def query(
        self,
        collection_name: str,
        query_embedding: list[float],
        n_results: int = 8,
        where: dict[str, Any] | None = None,  # kept for interface parity; unused for now
        query_text: str = "",
    ) -> dict[str, Any]:
        """Hybrid search. Returns a Chroma-shaped dict: {ids, metadatas, distances} each wrapped
        in a single-query outer list. `query_text` enables the keyword half of hybrid — pass the
        user's question; omit it (default '') for a pure-vector query."""
        body: dict[str, Any] = {
            "q": query_text,
            "vector": query_embedding,
            "hybrid": {"semanticRatio": self._semantic_ratio, "embedder": _EMBEDDER},
            "limit": n_results,
            "showRankingScore": True,
        }
        resp = self._client.post(f"/indexes/{collection_name}/search", json=body)
        resp.raise_for_status()
        hits = resp.json().get("hits", [])

        metadatas: list[dict[str, Any]] = []
        ids: list[str] = []
        distances: list[float] = []
        documents: list[str] = []
        for h in hits:
            ids.append(str(h.get("id")))
            documents.append(h.get("text", ""))
            # a higher Meili _rankingScore is better; Chroma distances are lower-is-better, so we
            # invert to keep any downstream 'smaller = closer' assumptions working.
            score = h.get("_rankingScore", 0.0)
            distances.append(1.0 - score)
            # metadata = everything except the reserved fields
            metadatas.append({k: v for k, v in h.items() if k not in ("text", "_vectors", "_rankingScore")})

        return {
            "ids": [ids],
            "documents": [documents],
            "metadatas": [metadatas],
            "distances": [distances],
        }

    def count(self, collection_name: str) -> int:
        resp = self._client.get(f"/indexes/{collection_name}/stats")
        if resp.status_code != 200:
            return 0
        return resp.json().get("numberOfDocuments", 0)

    def wait_for_tasks(self, timeout_s: float = 30.0) -> None:
        """Block until all enqueued indexing tasks finish — Meili indexes async, so call this
        after a reindex before querying, or the first searches see a partial index."""
        import time

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            resp = self._client.get("/tasks", params={"statuses": "enqueued,processing", "limit": 1})
            if resp.status_code == 200 and not resp.json().get("results"):
                return
            time.sleep(0.5)
