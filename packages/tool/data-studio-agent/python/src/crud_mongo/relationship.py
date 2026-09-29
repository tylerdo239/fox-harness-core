from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict

RELATIONSHIP_COLLECTION = "relationships"
COLUMN_PAIR_COLLECTION = "relationship_column_pairs"


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[RELATIONSHIP_COLLECTION].find({}))


def get_by_id(db: AttrDatabase, relationship_id: str) -> AttrDict | None:
    return db[RELATIONSHIP_COLLECTION].find_one({"_id": relationship_id})


def create(
    db: AttrDatabase,
    *,
    from_entity_id: str,
    to_entity_id: str,
    cardinality: str,
    join_type_default: str,
    is_curated: bool,
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "from_entity_id": from_entity_id,
        "to_entity_id": to_entity_id,
        "cardinality": cardinality,
        "join_type_default": join_type_default,
        "is_curated": is_curated,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[RELATIONSHIP_COLLECTION].insert_one(doc)
    return get_by_id(db, doc["_id"])


def update(db: AttrDatabase, relationship_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[RELATIONSHIP_COLLECTION].update_one({"_id": relationship_id}, {"$set": fields})
    return get_by_id(db, relationship_id)


def delete(db: AttrDatabase, relationship_id: str) -> bool:
    delete_column_pairs_by_relationship(db, relationship_id)
    result = db[RELATIONSHIP_COLLECTION].delete_one({"_id": relationship_id})
    return result.deleted_count > 0


def list_column_pairs(db: AttrDatabase, relationship_id: str) -> list[AttrDict]:
    return list(
        db[COLUMN_PAIR_COLLECTION].find({"relationship_id": relationship_id}).sort("seq", 1)
    )


def list_by_entity_ids(db: AttrDatabase, entity_ids: list[str]) -> list[AttrDict]:
    """Relationships where BOTH sides are in entity_ids — used to find join keys strictly between
    a fixed candidate set."""
    return list(db[RELATIONSHIP_COLLECTION].find({
        "from_entity_id": {"$in": entity_ids},
        "to_entity_id": {"$in": entity_ids},
    }))


def list_touching_entity_ids(db: AttrDatabase, entity_ids: list[str]) -> list[AttrDict]:
    """Relationships where EITHER side is in entity_ids (OR, not AND) — used to find neighbor
    entities reachable from a selected set (unlike list_by_entity_ids, which requires both sides
    already in the set)."""
    return list(db[RELATIONSHIP_COLLECTION].find({
        "$or": [
            {"from_entity_id": {"$in": entity_ids}},
            {"to_entity_id": {"$in": entity_ids}},
        ]
    }))


def list_column_pairs_by_relationship_ids(db: AttrDatabase, relationship_ids: list[str]) -> list[AttrDict]:
    return list(db[COLUMN_PAIR_COLLECTION].find({"relationship_id": {"$in": relationship_ids}}))


def create_column_pair(
    db: AttrDatabase, *, relationship_id: str, from_column_id: str, to_column_id: str, seq: int
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "relationship_id": relationship_id,
        "from_column_id": from_column_id,
        "to_column_id": to_column_id,
        "seq": seq,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[COLUMN_PAIR_COLLECTION].insert_one(doc)
    return db[COLUMN_PAIR_COLLECTION].find_one({"_id": doc["_id"]})


def delete_column_pairs_by_relationship(db: AttrDatabase, relationship_id: str) -> None:
    db[COLUMN_PAIR_COLLECTION].delete_many({"relationship_id": relationship_id})
