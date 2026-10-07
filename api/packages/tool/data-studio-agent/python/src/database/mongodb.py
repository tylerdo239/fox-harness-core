"""MongoDB connection setup (Plan 1 of the MySQL/SQLModel -> pymongo migration).

Runs alongside src/database/engine.py (SQLModel/MySQL/SQLite) until Plan 2's
cutover — see docs/superpowers/specs/2026-09-17-mysql-to-pymongo-design.md.
Uses PyMongo's synchronous client to match the sync call signatures used
throughout src/apis/routes/*.py.
"""

import asyncio
import logging
from typing import Any, Iterator

from pymongo import AsyncMongoClient, MongoClient
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.collection import Collection
from pymongo.cursor import Cursor
from pymongo.database import Database

from src.settings import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()
mongo_client: MongoClient = MongoClient(settings.mongodb_url)


class AttrDict(dict):
    """A dict that also supports attribute access (`d.field` as well as `d["field"]`).

    src/apis and src/services were built against SQLModel row objects (`.field`
    access), and FastAPI response models rely on Pydantic's `from_attributes=True`
    (calls `getattr()` internally). crud_mongo/ returns plain dicts internally;
    they're wrapped in this class at the query boundary so both access styles
    work identically without touching every `.field` call site.

    Only the top-level document is wrapped: a nested subdocument (e.g.
    `doc["foo"]` where `foo` is itself a dict) stays a plain `dict`, not
    another `AttrDict`, so `doc.foo.bar` won't work — callers that need
    attribute access on nested structures must wrap them explicitly.

    `.id` is a special-cased alias for the stored `_id` key (see
    `__getattr__`); a document that happens to also store a real `id` field
    can never be read via `.id` attribute access — only via `["id"]`.
    """

    def __getattr__(self, name: str) -> Any:
        if name == "id":
            # Mongo documents store their primary key as "_id"; SQLModel rows
            # (and every route built against them) expect ".id".
            try:
                return self["_id"]
            except KeyError:
                raise AttributeError(name) from None
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value


def _wrap(doc: dict | None) -> AttrDict | None:
    return AttrDict(doc) if doc is not None else None


class AttrCursor:
    """Wraps a pymongo Cursor so iteration yields AttrDict documents.

    Proxies every other call (sort/skip/limit/etc.) straight to the underlying
    cursor. Those methods mutate the cursor and return it for chaining
    (`find().sort().limit()`); when a proxied call returns the underlying
    cursor, this returns the wrapper instead, so chains keep yielding wrapped
    documents.
    """

    def __init__(self, cursor: Cursor):
        self._cursor = cursor

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._cursor, name)
        if not callable(attr):
            return attr

        def wrapped(*args, **kwargs):
            result = attr(*args, **kwargs)
            return self if result is self._cursor else result

        return wrapped

    def __iter__(self) -> Iterator[AttrDict]:
        return self

    def __next__(self) -> AttrDict:
        return AttrDict(next(self._cursor))


class AttrCollection:
    """Wraps a pymongo Collection: read methods return AttrDict/AttrCursor,
    everything else (insert_one, update_one, update_many, delete_one,
    delete_many, count_documents, ...) is proxied unchanged."""

    def __init__(self, collection: Collection):
        self._collection = collection

    def find(self, *args, **kwargs) -> AttrCursor:
        return AttrCursor(self._collection.find(*args, **kwargs))

    def find_one(self, *args, **kwargs) -> AttrDict | None:
        return _wrap(self._collection.find_one(*args, **kwargs))

    def find_one_and_update(self, *args, **kwargs) -> AttrDict | None:
        return _wrap(self._collection.find_one_and_update(*args, **kwargs))

    def find_one_and_delete(self, *args, **kwargs) -> AttrDict | None:
        return _wrap(self._collection.find_one_and_delete(*args, **kwargs))

    def aggregate(self, *args, **kwargs) -> AttrCursor:
        return AttrCursor(self._collection.aggregate(*args, **kwargs))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._collection, name)


class AttrDatabase:
    """Wraps a pymongo Database so every collection it hands out is an
    AttrCollection."""

    def __init__(self, database: Database):
        self._database = database

    def __getitem__(self, name: str) -> AttrCollection:
        return AttrCollection(self._database[name])

    def __getattr__(self, name: str) -> Any:
        return getattr(self._database, name)


def get_mongo_db() -> AttrDatabase:
    """Get the MongoDB database handle, wrapped for attribute-style access."""
    return AttrDatabase(mongo_client.get_default_database(settings.mongodb_database_name))


# Async client for pipeline v4. A client belongs to the event loop it first runs on, so keep one
# per loop (the server has one loop; scripts and tests may start several with asyncio.run).
_async_clients: dict[int, AsyncMongoClient] = {}


def get_async_mongo_db() -> AsyncDatabase:
    """Async database handle (plain dict documents) for the running event loop."""
    loop_id = id(asyncio.get_running_loop())
    client = _async_clients.get(loop_id)
    if client is None:
        client = _async_clients[loop_id] = AsyncMongoClient(settings.mongodb_url)
    return client.get_default_database(settings.mongodb_database_name)


def get_mongo_db_dependency() -> Iterator[AttrDatabase]:
    """FastAPI dependency version of get_mongo_db — see src/apis/deps.py MongoDep."""
    yield get_mongo_db()


def check_mongo_connection() -> bool:
    """Verify MongoDB is reachable."""
    try:
        mongo_client.admin.command("ping")
        return True
    except Exception as e:
        logger.error(f"MongoDB connection check failed: {e}")
        return False


def ensure_indexes(db: AttrDatabase | None = None) -> None:
    """Create the indexes the pipeline and admin UI rely on. Idempotent (an identical spec is a no-op)
    and tolerant: a database that already holds data (e.g. written by bot-data-studio-api, which
    creates no indexes) may violate a unique index — that is logged and skipped, never fatal.
    Keep this list identical to ensureIndexes() in services/gateway/src/mongo.ts."""
    db = db or get_mongo_db()
    specs: list[tuple[str, list[tuple[str, int]], dict]] = [
        ("data_sources", [("name", 1)], {"unique": True}),
        # physical_path, not physical_name: the sync walks nested folders, so one table name can appear in
        # two schemas of the same source (reference 2026-10).
        ("entities", [("data_source_id", 1), ("physical_path", 1)], {"unique": True}),
        ("entities", [("data_source_id", 1), ("is_deprecated", 1)], {}),
        ("entities", [("is_exposed", 1), ("is_deprecated", 1)], {}),
        ("entity_columns", [("entity_id", 1), ("physical_name", 1)], {"unique": True}),
        ("entity_columns", [("entity_id", 1), ("is_deprecated", 1), ("ordinal", 1)], {}),
        ("relationships", [("from_entity_id", 1)], {}),
        ("relationships", [("to_entity_id", 1)], {}),
        ("relationship_column_pairs", [("relationship_id", 1), ("seq", 1)], {}),
        ("metrics", [("name", 1)], {}),
        ("profile_metrics", [("name", 1)], {}),
        ("profile_glossary", [("term", 1)], {}),
        ("business_glossary", [("term", 1)], {}),
        ("verified_queries", [("is_verified", 1)], {}),
        ("conversations", [("updated_at", -1)], {}),
        ("messages", [("conversation_id", 1), ("seq", 1)], {"unique": True}),
        ("query_results", [("message_id", 1), ("seq", 1)], {}),
        ("charts", [("query_result_id", 1)], {}),
        ("dashboards", [("updated_at", -1)], {}),
        # per-user dashboards and charts (docs/data-studio-user-dashboards-plan.md); same in services/gateway/src/mongo.ts
        ("dashboards", [("owner_id", 1), ("updated_at", -1)], {}),
        ("charts", [("owner_id", 1), ("created_at", -1)], {}),
        ("dashboard_widgets", [("dashboard_id", 1), ("seq", 1)], {}),
    ]
    # Replaced 2026-10-06 by the unique (data_source_id, physical_path) above; left in place it would still refuse a
    # table name repeated in two schemas of one source. Already gone = fine. Same in services/gateway/src/mongo.ts.
    try:
        db["entities"].drop_index("data_source_id_1_physical_name_1")
    except Exception:  # noqa: BLE001
        pass
    for collection, keys, options in specs:
        try:
            db[collection].create_index(keys, **options)
        except Exception as e:  # noqa: BLE001 — never block startup on an index
            logger.warning("ensure_indexes: skipped %s %s: %s", collection, keys, e)
