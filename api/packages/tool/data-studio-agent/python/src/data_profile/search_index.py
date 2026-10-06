"""Search index for pipeline v4, updated whenever a profile is saved.

Three Meilisearch indexes, separate from the old pipeline's:

  v4_tables   one doc per exposed table       keyword + embedding (hybrid)
  v4_columns  one doc per exposed column      keyword + embedding (hybrid)
  v4_values   one doc per value-catalog item  keyword only ("miền Nam" → region = MN)

Only exposed, non-deprecated, non-PII tables/columns are indexed; hiding or deprecating one
removes it. Indexing never blocks a save: failures are recorded on the entity as
`search_index.status = "stale"` and fixed with a rebuild.
"""

import hashlib
import logging
import time
from typing import Any

import httpx

from src.crud_mongo import entity as entity_crud
from src.crud_mongo._shared import utcnow
from src.data_profile import service
from src.database.mongodb import AttrDatabase
from src.settings import Settings

log = logging.getLogger(__name__)

TABLES, COLUMNS, VALUES, METRICS, GLOSSARY = "v4_tables", "v4_columns", "v4_values", "v4_metrics", "v4_glossary"
EMBEDDER = "profile"
_EMBED_BATCH = 64
_TASK_TIMEOUT_S = 20.0

_FILTERABLE = ["data_source_id", "entity_id", "column_id", "json_parent_id"]
_INDEX_SETTINGS: dict[str, dict[str, Any]] = {
    TABLES: {
        "searchableAttributes": ["display_name", "physical_name", "synonyms", "description", "grain_description"],
        "filterableAttributes": _FILTERABLE,
    },
    COLUMNS: {
        "searchableAttributes": ["display_name", "physical_name", "synonyms", "description", "table_name"],
        "filterableAttributes": [*_FILTERABLE, "role", "semantic_type"],
    },
    VALUES: {
        "searchableAttributes": ["label", "synonyms", "value", "column_name"],
        "filterableAttributes": _FILTERABLE,
    },
    METRICS: {
        "searchableAttributes": ["display_name", "name", "synonyms", "description", "example_questions"],
        "filterableAttributes": ["data_source_id", "entity_id", "kind"],
    },
    GLOSSARY: {
        "searchableAttributes": ["display_name", "synonyms", "description", "example_questions"],
        "filterableAttributes": ["data_source_id", "entity_id", "kind"],
    },
}


# Meilisearch URLs whose indexes are already set up in this process (setup is idempotent but costs
# a few round-trips and an embedding call, so do it once rather than on every save)
_READY: set[str] = set()


def _doc_id(column_id: str) -> str:
    """Meilisearch ids allow only letters, digits, - and _; JSON field ids contain '#'."""
    return column_id.replace(service.JSON_ID_SEP, "__").replace(".", "_")


class IndexError_(RuntimeError):
    """Meilisearch or the embedding service failed; the message is stored on the entity."""


class ProfileSearchIndex:
    def __init__(self, settings: Settings) -> None:
        headers = {"Content-Type": "application/json"}
        if settings.meilisearch_master_key:
            headers["Authorization"] = f"Bearer {settings.meilisearch_master_key}"
        self._meili_url = settings.meilisearch_url.rstrip("/")
        self._meili = httpx.Client(base_url=self._meili_url, headers=headers, timeout=30)
        self._embed_url = f"{(settings.embedding_base_url or '').rstrip('/')}/embeddings"
        self._embed_headers = {"Authorization": f"Bearer {settings.embedding_api_key}"} if settings.embedding_api_key else {}
        self._embed_model = settings.embedding_model_id

    # ── low level ──

    def _call(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            resp = self._meili.request(method, path, **kwargs)
        except httpx.HTTPError as err:
            raise IndexError_(f"search index unreachable: {err}") from err
        if resp.status_code >= 400:
            raise IndexError_(f"search index error {resp.status_code}: {resp.text[:200]}")
        return resp.json() if resp.content else {}

    def _wait(self, task: dict[str, Any]) -> None:
        """Meilisearch applies writes asynchronously; wait so a failure is reported, not lost."""
        uid = task.get("taskUid")
        if uid is None:
            return
        deadline = time.monotonic() + _TASK_TIMEOUT_S
        while time.monotonic() < deadline:
            info = self._call("GET", f"/tasks/{uid}")
            if info.get("status") == "succeeded":
                return
            if info.get("status") in ("failed", "canceled"):
                raise IndexError_(f"search index task failed: {(info.get('error') or {}).get('message')}")
            time.sleep(0.2)
        raise IndexError_("search index task timed out")

    def _embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), _EMBED_BATCH):
            batch = [f"search_document: {t}" for t in texts[start:start + _EMBED_BATCH]]
            try:
                resp = httpx.post(
                    self._embed_url, headers=self._embed_headers,
                    json={"model": self._embed_model, "input": batch}, timeout=30,
                )
                resp.raise_for_status()
            except httpx.HTTPError as err:
                raise IndexError_(f"embedding service failed: {err}") from err
            vectors += [item["embedding"] for item in sorted(resp.json()["data"], key=lambda d: d["index"])]
        return vectors

    def ensure_indexes(self) -> None:
        if self._meili_url in _READY:
            return
        existing = {i["uid"] for i in self._call("GET", "/indexes", params={"limit": 1000}).get("results", [])}
        for uid, settings in _INDEX_SETTINGS.items():
            if uid not in existing:
                self._wait(self._call("POST", "/indexes", json={"uid": uid, "primaryKey": "id"}))
            body = dict(settings)
            if uid in (TABLES, COLUMNS, METRICS, GLOSSARY):
                dims = len(self._embed(["dimension probe"])[0])
                body["embedders"] = {EMBEDDER: {"source": "userProvided", "dimensions": dims}}
            self._wait(self._call("PATCH", f"/indexes/{uid}/settings", json=body))
        _READY.add(self._meili_url)

    def _upsert(self, uid: str, docs: list[dict[str, Any]]) -> None:
        if docs:
            self._wait(self._call("POST", f"/indexes/{uid}/documents", json=docs))

    def _delete_where(self, uid: str, filter_expr: str) -> None:
        self._wait(self._call("POST", f"/indexes/{uid}/documents/delete", json={"filter": filter_expr}))

    def _delete_ids(self, uid: str, ids: list[str]) -> None:
        if ids:
            self._wait(self._call("POST", f"/indexes/{uid}/documents/delete-batch", json=ids))

    # ── documents ──

    @staticmethod
    def _table_doc(entity: dict[str, Any]) -> dict[str, Any]:
        profile = service.entity_profile(entity)
        return {
            "id": entity["_id"],
            "entity_id": entity["_id"],
            "data_source_id": entity["data_source_id"],
            "physical_path": entity["physical_path"],
            "physical_name": entity["physical_name"],
            "display_name": entity.get("display_name") or entity["physical_name"],
            "synonyms": entity.get("synonyms") or [],
            "description": entity.get("description"),
            "grain_description": entity.get("grain_description"),
            "table_kind": profile.table_kind,
            "trust": profile.trust,
        }

    @staticmethod
    def _column_doc(entity: dict[str, Any], column: dict[str, Any]) -> dict[str, Any]:
        profile = service.column_profile(column)
        return {
            "id": _doc_id(column["_id"]),
            "json_parent_id": column.get("json_parent_id"),
            "column_id": column["_id"],
            "entity_id": entity["_id"],
            "data_source_id": entity["data_source_id"],
            "table_name": entity.get("display_name") or entity["physical_name"],
            "physical_name": column["physical_name"],
            "display_name": column.get("display_name") or column["physical_name"],
            "synonyms": column.get("synonyms") or [],
            "description": column.get("description"),
            "role": column.get("role"),
            "semantic_type": column.get("semantic_type"),
            "unit": profile.unit,
        }

    @staticmethod
    def _value_docs(entity: dict[str, Any], column: dict[str, Any]) -> list[dict[str, Any]]:
        docs = []
        for item in service.column_profile(column).value_catalog:
            digest = hashlib.sha1(f"{column['_id']}\x00{item.value}".encode()).hexdigest()[:20]
            docs.append({
                "id": f"{_doc_id(column['_id'])}_{digest}",
                "json_parent_id": column.get("json_parent_id"),
                "column_id": column["_id"],
                "entity_id": entity["_id"],
                "data_source_id": entity["data_source_id"],
                "column_name": column.get("display_name") or column["physical_name"],
                "value": item.value,
                "label": item.label,
                "synonyms": item.synonyms,
            })
        return docs

    @staticmethod
    def _embed_text(doc: dict[str, Any]) -> str:
        parts = [doc["display_name"], doc["physical_name"], doc.get("description"), " ".join(doc["synonyms"])]
        if doc.get("grain_description"):
            parts.append(doc["grain_description"])
        return " | ".join(p for p in parts if p)

    def _with_vectors(self, docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        vectors = self._embed([self._embed_text(d) for d in docs])
        return [{**d, "_vectors": {EMBEDDER: {"embeddings": v, "regenerate": False}}} for d, v in zip(docs, vectors, strict=True)]

    # ── operations ──

    @staticmethod
    def entity_indexable(entity: dict[str, Any]) -> bool:
        return bool(entity.get("is_exposed")) and not entity.get("is_deprecated") and not entity.get("is_pii")

    @staticmethod
    def column_indexable(column: dict[str, Any]) -> bool:
        return bool(column.get("is_exposed")) and not column.get("is_deprecated") and not column.get("is_pii")

    def index_table_doc(self, entity: dict[str, Any]) -> None:
        """Refresh only the table's own document (name, description… changed)."""
        self.ensure_indexes()
        if self.entity_indexable(entity):
            self._upsert(TABLES, self._with_vectors([self._table_doc(entity)]))
        else:
            self.remove_entity(entity["_id"])

    def index_columns(self, entity: dict[str, Any], columns: list[dict[str, Any]]) -> None:
        """Refresh these columns and their values; hidden/PII/deprecated ones are removed."""
        self.ensure_indexes()
        if not self.entity_indexable(entity):
            self.remove_entity(entity["_id"])
            return
        keep = [c for c in columns if self.column_indexable(c)]
        drop = [c["_id"] for c in columns if not self.column_indexable(c)]
        self._delete_ids(COLUMNS, [_doc_id(cid) for cid in drop])
        ids = ", ".join(f"'{c['_id']}'" for c in columns)
        if ids:
            # values of these columns, and every JSON field declared on them (then re-add the current ones)
            self._delete_where(VALUES, f"column_id IN [{ids}] OR json_parent_id IN [{ids}]")
            self._delete_where(COLUMNS, f"json_parent_id IN [{ids}]")
        docs = [*keep, *service.json_columns(keep)]
        self._upsert(COLUMNS, self._with_vectors([self._column_doc(entity, c) for c in docs]))
        self._upsert(VALUES, [v for c in docs for v in self._value_docs(entity, c)])

    def index_entity(self, db: AttrDatabase, entity: dict[str, Any]) -> None:
        """Rebuild everything for one table."""
        self.ensure_indexes()
        self.remove_entity(entity["_id"])
        if self.entity_indexable(entity):
            self._upsert(TABLES, self._with_vectors([self._table_doc(entity)]))
            self.index_columns(entity, service.entity_columns(db, entity["_id"]))

    def remove_entity(self, entity_id: str) -> None:
        self.ensure_indexes()
        for uid in (TABLES, COLUMNS, VALUES):
            self._delete_where(uid, f"entity_id = '{entity_id}'")

    def index_metric(self, doc: dict[str, Any], data_source_id: str | None) -> None:
        self.ensure_indexes()
        item = {
            "id": doc["_id"],
            "name": doc["name"],
            "display_name": doc.get("display_name") or doc["name"],
            "physical_name": doc["name"],
            "synonyms": doc.get("synonyms") or [],
            "description": doc.get("description"),
            "example_questions": doc.get("example_questions") or [],
            "kind": doc.get("kind"),
            "entity_id": doc.get("entity_id"),
            "data_source_id": data_source_id,
            "unit": doc.get("unit"),
        }
        text = self._embed_text(item) + (" | " + " | ".join(item["example_questions"]) if item["example_questions"] else "")
        vector = self._embed([text])[0]
        self._upsert(METRICS, [{**item, "_vectors": {EMBEDDER: {"embeddings": vector, "regenerate": False}}}])

    def index_glossary_term(self, doc: dict[str, Any], data_source_id: str | None) -> None:
        self.ensure_indexes()
        item = {
            "id": doc["_id"],
            "display_name": doc["term"],
            "physical_name": doc["term"],
            "synonyms": doc.get("synonyms") or [],
            "description": doc.get("definition"),
            "example_questions": doc.get("example_questions") or [],
            "kind": doc.get("kind"),
            "entity_id": doc.get("entity_id"),
            "metric_id": doc.get("metric_id"),
            "data_source_id": data_source_id,
        }
        text = self._embed_text(item) + (" | " + " | ".join(item["example_questions"]) if item["example_questions"] else "")
        vector = self._embed([text])[0]
        self._upsert(GLOSSARY, [{**item, "_vectors": {EMBEDDER: {"embeddings": vector, "regenerate": False}}}])

    def remove_glossary_term(self, term_id: str) -> None:
        self.ensure_indexes()
        self._delete_ids(GLOSSARY, [term_id])

    def remove_metric(self, metric_id: str) -> None:
        self.ensure_indexes()
        self._delete_ids(METRICS, [metric_id])

    def remove_data_source(self, data_source_id: str) -> None:
        self.ensure_indexes()
        for uid in (TABLES, COLUMNS, VALUES, METRICS, GLOSSARY):
            self._delete_where(uid, f"data_source_id = '{data_source_id}'")


# ── status bookkeeping (best effort: a save never fails because of search) ──

def _set_status(db: AttrDatabase, entity_id: str, status: str, error: str | None = None) -> None:
    fields: dict[str, Any] = {"status": status, "error": error, "updated_at": utcnow().isoformat()}
    entity_crud.update(db, entity_id, search_index=fields)


def run_indexing(db: AttrDatabase, settings: Settings, entity_id: str, action: str, **kwargs: Any) -> None:
    """Run one index action for an entity and record the outcome on it.

    action: "table" (table doc; add full=True to also redo columns), "columns" (column_ids=[...]),
    or "entity" (full rebuild). A table already marked stale always gets a full rebuild.
    """
    entity = entity_crud.get_by_id(db, entity_id)
    if entity is None:
        return
    index = ProfileSearchIndex(settings)
    was_stale = (entity.get("search_index") or {}).get("status") != "ok"
    try:
        if action == "entity" or was_stale or kwargs.get("full"):
            index.index_entity(db, entity)
        elif action == "table":
            index.index_table_doc(entity)
        elif action == "columns":
            wanted = set(kwargs.get("column_ids") or [])
            columns = [c for c in service.entity_columns(db, entity_id) if c["_id"] in wanted]
            index.index_columns(entity, columns)
        _set_status(db, entity_id, "ok")
    except IndexError_ as err:
        _READY.clear()  # e.g. Meilisearch restarted empty: redo the setup on the next attempt
        log.warning("search indexing failed for entity %s: %s", entity_id, err)
        _set_status(db, entity_id, "stale", str(err))


def mark_stale(db: AttrDatabase, entity_id: str, reason: str) -> None:
    _set_status(db, entity_id, "stale", reason)


def run_metric_indexing(db: AttrDatabase, settings: Settings, metric_id: str, *, remove: bool = False) -> None:
    """Index (or remove) one metric and record the outcome on it; never raises."""
    from src.data_profile import metrics as metric_service  # local import: metrics imports service too

    index = ProfileSearchIndex(settings)
    try:
        if remove:
            index.remove_metric(metric_id)
            return
        doc = metric_service.get_doc(db, metric_id)
        if doc is None:
            return
        entity = entity_crud.get_by_id(db, doc["entity_id"]) if doc.get("entity_id") else None
        index.index_metric(doc, entity["data_source_id"] if entity else None)
        metric_service.set_index_status(db, metric_id, "ok")
    except IndexError_ as err:
        _READY.clear()
        log.warning("search indexing failed for metric %s: %s", metric_id, err)
        if not remove:
            metric_service.set_index_status(db, metric_id, "stale", str(err))


def run_glossary_indexing(db: AttrDatabase, settings: Settings, term_id: str, *, remove: bool = False) -> None:
    """Index (or remove) one glossary term and record the outcome on it; never raises."""
    from src.data_profile import glossary as glossary_service  # local import: avoids an import cycle

    index = ProfileSearchIndex(settings)
    try:
        if remove:
            index.remove_glossary_term(term_id)
            return
        doc = glossary_service.get_doc(db, term_id)
        if doc is None:
            return
        entity = entity_crud.get_by_id(db, doc["entity_id"]) if doc.get("entity_id") else None
        index.index_glossary_term(doc, entity["data_source_id"] if entity else None)
        glossary_service.set_index_status(db, term_id, "ok")
    except IndexError_ as err:
        _READY.clear()
        log.warning("search indexing failed for glossary term %s: %s", term_id, err)
        if not remove:
            glossary_service.set_index_status(db, term_id, "stale", str(err))
