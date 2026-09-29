from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict

COLLECTION = "entities"


def get_by_id(db: AttrDatabase, entity_id: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"_id": entity_id})


def list_by_data_source(db: AttrDatabase, data_source_id: str) -> list[AttrDict]:
    return list(
        db[COLLECTION].find({"data_source_id": data_source_id, "is_deprecated": False})
    )


def count_by_data_source(db: AttrDatabase, data_source_id: str) -> int:
    return db[COLLECTION].count_documents(
        {"data_source_id": data_source_id, "is_deprecated": False}
    )


def list_active(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({"is_deprecated": False}))


def list_exposed_active(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({"is_exposed": True, "is_deprecated": False}))


def list_by_data_source_ids(db: AttrDatabase, data_source_ids: list[str]) -> list[AttrDict]:
    """Every entity under these data sources, INCLUDING deprecated ones — used by the Dremio
    sync's soft-delete sweep, which must see already-deprecated entities too (to leave them
    alone) as well as active ones (to detect which disappeared from this sync run)."""
    return list(db[COLLECTION].find({"data_source_id": {"$in": data_source_ids}}))


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({}))


def list_by_ids(db: AttrDatabase, entity_ids: list[str]) -> list[AttrDict]:
    return list(db[COLLECTION].find({"_id": {"$in": entity_ids}}))


def get_by_physical_name(db: AttrDatabase, data_source_id: str, physical_name: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"data_source_id": data_source_id, "physical_name": physical_name})


def create(
    db: AttrDatabase,
    *,
    data_source_id: str,
    physical_path: str,
    physical_name: str,
    entity_type: str,
    display_name: str,
    is_exposed: bool = False,
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "data_source_id": data_source_id,
        "physical_path": physical_path,
        "physical_name": physical_name,
        "entity_type": entity_type,
        "last_synced_at": None,
        "is_deprecated": False,
        "display_name": display_name,
        "description": None,
        "synonyms": [],
        "grain_description": None,
        "is_exposed": is_exposed,
        "is_pii": False,
        "row_count_est": None,
        "last_profiled_at": None,
        "embed_text": None,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[COLLECTION].insert_one(doc)
    return get_by_id(db, doc["_id"])


def update(db: AttrDatabase, entity_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[COLLECTION].update_one({"_id": entity_id}, {"$set": fields})
    return get_by_id(db, entity_id)
