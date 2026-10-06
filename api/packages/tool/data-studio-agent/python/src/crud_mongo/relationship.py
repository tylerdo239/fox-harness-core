from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict
from src.security import role

RELATIONSHIP_COLLECTION = "relationships"
COLUMN_PAIR_COLLECTION = "relationship_column_pairs"


# relationships are soft-deleted: every list below only returns active ones
_ACTIVE = {"deleted_at": None}


def _visible(db: AttrDatabase, docs: list) -> list:
    """A relationship is visible to a non-admin only if BOTH tables are: a join through a hidden table
    would let a query reach it."""
    docs = [d for d in docs if d is not None]
    if role.is_admin() or not docs:
        return docs
    entities = role.visible_entity_ids(db) or set()
    return [d for d in docs if d.get("from_entity_id") in entities and d.get("to_entity_id") in entities]


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return _visible(db, list(db[RELATIONSHIP_COLLECTION].find(_ACTIVE)))


def get_by_id(db: AttrDatabase, relationship_id: str) -> AttrDict | None:
    kept = _visible(db, [db[RELATIONSHIP_COLLECTION].find_one({"_id": relationship_id})])
    return kept[0] if kept else None


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
        "deleted_at": None,
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
    """Soft delete: sets deleted_at and keeps the document and its column pairs."""
    result = db[RELATIONSHIP_COLLECTION].update_one(
        {"_id": relationship_id, **_ACTIVE}, {"$set": {"deleted_at": utcnow(), "updated_at": utcnow()}}
    )
    return result.modified_count > 0


def list_column_pairs(db: AttrDatabase, relationship_id: str) -> list[AttrDict]:
    return list(
        db[COLUMN_PAIR_COLLECTION].find({"relationship_id": relationship_id, **_ACTIVE}).sort("seq", 1)
    )


def list_by_entity_ids(db: AttrDatabase, entity_ids: list[str]) -> list[AttrDict]:
    """Relationships where BOTH sides are in entity_ids — used to find join keys strictly between
    a fixed candidate set."""
    return _visible(db, list(db[RELATIONSHIP_COLLECTION].find({
        "from_entity_id": {"$in": entity_ids},
        "to_entity_id": {"$in": entity_ids},
        **_ACTIVE,
    })))


def list_touching_entity_ids(db: AttrDatabase, entity_ids: list[str]) -> list[AttrDict]:
    """Relationships where EITHER side is in entity_ids (OR, not AND) — used to find neighbor
    entities reachable from a selected set (unlike list_by_entity_ids, which requires both sides
    already in the set)."""
    return _visible(db, list(db[RELATIONSHIP_COLLECTION].find({
        "$or": [
            {"from_entity_id": {"$in": entity_ids}},
            {"to_entity_id": {"$in": entity_ids}},
        ],
        **_ACTIVE,
    })))


def list_column_pairs_by_relationship_ids(db: AttrDatabase, relationship_ids: list[str]) -> list[AttrDict]:
    return list(db[COLUMN_PAIR_COLLECTION].find({"relationship_id": {"$in": relationship_ids}, **_ACTIVE}))


def create_column_pair(
    db: AttrDatabase, *, relationship_id: str, from_column_id: str, to_column_id: str, seq: int
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "relationship_id": relationship_id,
        "from_column_id": from_column_id,
        "to_column_id": to_column_id,
        "seq": seq,
        "deleted_at": None,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[COLUMN_PAIR_COLLECTION].insert_one(doc)
    return db[COLUMN_PAIR_COLLECTION].find_one({"_id": doc["_id"]})


def delete_column_pairs_by_relationship(db: AttrDatabase, relationship_id: str) -> None:
    """Soft delete: the pairs are replaced on edit, the old rows are kept with deleted_at."""
    db[COLUMN_PAIR_COLLECTION].update_many(
        {"relationship_id": relationship_id, **_ACTIVE}, {"$set": {"deleted_at": utcnow(), "updated_at": utcnow()}}
    )
