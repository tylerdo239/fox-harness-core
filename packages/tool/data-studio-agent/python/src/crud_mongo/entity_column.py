from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict
from src.security import role

COLLECTION = "entity_columns"


def _q(query: dict) -> dict:
    """Every read is scoped to what the current role may see (src/security/role.py); admin: unchanged."""
    return {**query, **role.catalog_filter()}


def _visible(db: AttrDatabase, docs: list) -> list:
    """A column is visible to a non-admin only if its ENTITY is visible too (a column flag alone is not
    enough: an admin may opt a column in on a table that stays admin-only)."""
    docs = [d for d in docs if d is not None]
    if role.is_admin() or not docs:
        return docs
    entity_ids = list({d.get("entity_id") for d in docs})
    visible = {e["_id"] for e in db["entities"].find({"_id": {"$in": entity_ids}, **role.catalog_filter()}, {"_id": 1})}
    return [d for d in docs if d.get("entity_id") in visible]


def _one(db: AttrDatabase, doc):
    kept = _visible(db, [doc]) if doc is not None else []
    return kept[0] if kept else None


def get_by_id(db: AttrDatabase, column_id: str) -> AttrDict | None:
    return _one(db, db[COLLECTION].find_one(_q({"_id": column_id})))


def list_by_entity(db: AttrDatabase, entity_id: str) -> list[AttrDict]:
    return _visible(db, list(
        db[COLLECTION]
        .find(_q({"entity_id": entity_id, "is_deprecated": False}))
        .sort("ordinal", 1)
    ))


def count_by_entity(db: AttrDatabase, entity_id: str) -> int:
    return len(list_by_entity(db, entity_id)) if not role.is_admin() else db[COLLECTION].count_documents({"entity_id": entity_id, "is_deprecated": False})


def list_by_ids(db: AttrDatabase, column_ids: list[str]) -> list[AttrDict]:
    return _visible(db, list(db[COLLECTION].find(_q({"_id": {"$in": column_ids}}))))


def list_by_entity_ids(db: AttrDatabase, entity_ids: list[str]) -> list[AttrDict]:
    """Non-deprecated columns across MULTIPLE entities — used to build the blocked-column set for
    SQL validation (one query across every entity in scope, not per-entity)."""
    return _visible(db, list(db[COLLECTION].find(_q({"entity_id": {"$in": entity_ids}, "is_deprecated": False}))))


def list_exposed_by_entity(db: AttrDatabase, entity_id: str) -> list[AttrDict]:
    return _visible(db, list(
        db[COLLECTION].find(_q({"entity_id": entity_id, "is_exposed": True, "is_deprecated": False}))
    ))


def get_by_entity_and_name(db: AttrDatabase, entity_id: str, physical_name: str) -> AttrDict | None:
    return _one(db, db[COLLECTION].find_one(_q({"entity_id": entity_id, "physical_name": physical_name})))


def best_label_column(db: AttrDatabase, entity_id: str) -> AttrDict | None:
    """The best human-readable label column for an entity: exposed, non-deprecated, not a key,
    a TEXT semantic type, lowest ordinal first. Mirrors schema_linking.py's original SQL query
    (role != KEY, semantic_type == TEXT, ordered by ordinal, first())."""
    docs = _visible(db, list(
        db[COLLECTION]
        .find(_q({
            "entity_id": entity_id,
            "is_exposed": True,
            "is_deprecated": False,
            "role": {"$nin": ["key", None]},
            "semantic_type": "text",
        }))
        .sort("ordinal", 1)
    ))
    return docs[0] if docs else None


def list_by_entity_all(db: AttrDatabase, entity_id: str) -> list[AttrDict]:
    """Every column for this entity, INCLUDING deprecated ones — used by the Dremio sync
    reconciliation, which needs to see already-deprecated columns too (to leave them alone)
    as well as active ones (to detect which disappeared from this sync run)."""
    return _visible(db, list(db[COLLECTION].find(_q({"entity_id": entity_id}))))


def list_exposed_active(db: AttrDatabase) -> list[AttrDict]:
    return _visible(db, list(db[COLLECTION].find(_q({"is_exposed": True, "is_deprecated": False}))))


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return _visible(db, list(db[COLLECTION].find(_q({}))))


def create(
    db: AttrDatabase,
    *,
    entity_id: str,
    physical_name: str,
    data_type: str,
    ordinal: int,
    display_name: str,
    is_exposed: bool = False,
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "entity_id": entity_id,
        "physical_name": physical_name,
        "data_type": data_type,
        "ordinal": ordinal,
        "is_nullable": True,
        "is_deprecated": False,
        "last_synced_at": None,
        "display_name": display_name,
        "description": None,
        "synonyms": [],
        "role": None,
        "semantic_type": None,
        "default_aggregation": None,
        "value_glossary": {},
        "is_exposed": is_exposed,
        "is_pii": False,
        # admin-only until an admin opts the column in for role user (src/security/role.py)
        "allowed_roles": ["admin"],
        "is_default_select": False,
        "distinct_count": None,
        "sample_values": [],
        "min_val": None,
        "max_val": None,
        "null_ratio": None,
        "last_profiled_at": None,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[COLLECTION].insert_one(doc)
    return get_by_id(db, doc["_id"])


def update(db: AttrDatabase, column_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[COLLECTION].update_one({"_id": column_id}, {"$set": fields})
    return get_by_id(db, column_id)
