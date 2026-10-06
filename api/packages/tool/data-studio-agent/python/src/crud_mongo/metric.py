from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict
from src.security import role

COLLECTION = "metrics"


def _visible(db: AttrDatabase, docs: list) -> list:
    """A metric is visible to a non-admin only if its base table and the columns it is computed from are;
    dimension columns the role may not see are stripped rather than hiding the whole metric."""
    docs = [d for d in docs if d is not None]
    if role.unrestricted() or not docs:
        return docs
    entities = role.visible_entity_ids(db) or set()
    referenced = [c for d in docs for c in [d.get("measure_column_id"), d.get("time_column_id"), *(d.get("allowed_dimension_column_ids") or [])] if c]
    columns = role.visible_column_ids(db, referenced) or set()
    kept = []
    for d in docs:
        if d.get("base_entity_id") not in entities:
            continue
        if any(c and c not in columns for c in (d.get("measure_column_id"), d.get("time_column_id"))):
            continue
        d["allowed_dimension_column_ids"] = [c for c in (d.get("allowed_dimension_column_ids") or []) if c in columns]
        kept.append(d)
    return kept


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return _visible(db, list(db[COLLECTION].find({})))


def get_by_id(db: AttrDatabase, metric_id: str) -> AttrDict | None:
    kept = _visible(db, [db[COLLECTION].find_one({"_id": metric_id})])
    return kept[0] if kept else None


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
