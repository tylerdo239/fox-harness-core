from src.crud_mongo._shared import utcnow
from src.database.mongodb import AttrDatabase, AttrDict

COLLECTION = "verified_queries"


def get_by_id(db: AttrDatabase, query_id: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"_id": query_id})


def list_verified(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({"is_verified": True}))


def update(db: AttrDatabase, query_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[COLLECTION].update_one({"_id": query_id}, {"$set": fields})
    return get_by_id(db, query_id)
