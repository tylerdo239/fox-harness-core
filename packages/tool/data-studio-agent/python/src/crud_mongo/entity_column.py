from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict

COLLECTION = "entity_columns"


def get_by_id(db: AttrDatabase, column_id: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"_id": column_id})


def list_by_entity(db: AttrDatabase, entity_id: str) -> list[AttrDict]:
    return list(
        db[COLLECTION]
        .find({"entity_id": entity_id, "is_deprecated": False})
        .sort("ordinal", 1)
    )


def count_by_entity(db: AttrDatabase, entity_id: str) -> int:
    return db[COLLECTION].count_documents({"entity_id": entity_id, "is_deprecated": False})


def list_by_ids(db: AttrDatabase, column_ids: list[str]) -> list[AttrDict]:
    return list(db[COLLECTION].find({"_id": {"$in": column_ids}}))


def list_by_entity_ids(db: AttrDatabase, entity_ids: list[str]) -> list[AttrDict]:
    """Non-deprecated columns across MULTIPLE entities — used to build the blocked-column set for
    SQL validation (one query across every entity in scope, not per-entity)."""
    return list(db[COLLECTION].find({"entity_id": {"$in": entity_ids}, "is_deprecated": False}))


def list_exposed_by_entity(db: AttrDatabase, entity_id: str) -> list[AttrDict]:
    return list(
        db[COLLECTION].find({"entity_id": entity_id, "is_exposed": True, "is_deprecated": False})
    )


def get_by_entity_and_name(db: AttrDatabase, entity_id: str, physical_name: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"entity_id": entity_id, "physical_name": physical_name})


def best_label_column(db: AttrDatabase, entity_id: str) -> AttrDict | None:
    """The best human-readable label column for an entity: exposed, non-deprecated, not a key,
    a TEXT semantic type, lowest ordinal first. Mirrors schema_linking.py's original SQL query
    (role != KEY, semantic_type == TEXT, ordered by ordinal, first())."""
    docs = list(
        db[COLLECTION]
        .find({
            "entity_id": entity_id,
            "is_exposed": True,
            "is_deprecated": False,
            "role": {"$nin": ["key", None]},
            "semantic_type": "text",
        })
        .sort("ordinal", 1)
        .limit(1)
    )
    return docs[0] if docs else None


def list_by_entity_all(db: AttrDatabase, entity_id: str) -> list[AttrDict]:
    """Every column for this entity, INCLUDING deprecated ones — used by the Dremio sync
    reconciliation, which needs to see already-deprecated columns too (to leave them alone)
    as well as active ones (to detect which disappeared from this sync run)."""
    return list(db[COLLECTION].find({"entity_id": entity_id}))


def list_exposed_active(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({"is_exposed": True, "is_deprecated": False}))


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({}))


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
