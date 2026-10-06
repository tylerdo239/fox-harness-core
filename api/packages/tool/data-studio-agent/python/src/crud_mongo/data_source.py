from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict

COLLECTION = "data_sources"


def get_by_id(db: AttrDatabase, data_source_id: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"_id": data_source_id})


def get_by_name(db: AttrDatabase, name: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"name": name})


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({}))


def list_active(db: AttrDatabase) -> list[AttrDict]:
    """Sources that haven't been soft-deleted (deleted_at unset or null)."""
    return list(db[COLLECTION].find({"deleted_at": None}))


def create(
    db: AttrDatabase,
    *,
    name: str,
    source_type: str,
    dremio_path: str,
    status: str,
    last_synced_at=None,
    is_exposed_to_agent: bool = False,
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "name": name,
        "source_type": source_type,
        "dremio_path": dremio_path,
        "status": status,
        "last_synced_at": last_synced_at,
        "is_exposed_to_agent": is_exposed_to_agent,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[COLLECTION].insert_one(doc)
    return get_by_id(db, doc["_id"])


def update(db: AttrDatabase, data_source_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[COLLECTION].update_one({"_id": data_source_id}, {"$set": fields})
    return get_by_id(db, data_source_id)
