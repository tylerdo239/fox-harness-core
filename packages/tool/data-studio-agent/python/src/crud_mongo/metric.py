from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict

COLLECTION = "metrics"


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({}))


def get_by_id(db: AttrDatabase, metric_id: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"_id": metric_id})


def create(db: AttrDatabase, **fields) -> AttrDict:
    doc = {"_id": new_id(), "created_at": utcnow(), "updated_at": utcnow(), **fields}
    db[COLLECTION].insert_one(doc)
    return get_by_id(db, doc["_id"])


def update(db: AttrDatabase, metric_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[COLLECTION].update_one({"_id": metric_id}, {"$set": fields})
    return get_by_id(db, metric_id)


def delete(db: AttrDatabase, metric_id: str) -> bool:
    result = db[COLLECTION].delete_one({"_id": metric_id})
    return result.deleted_count > 0
