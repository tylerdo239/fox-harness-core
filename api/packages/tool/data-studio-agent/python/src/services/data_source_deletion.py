from datetime import UTC, datetime
from typing import Any

from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.database.mongodb import AttrDatabase, AttrDict


def soft_delete_data_source(db: AttrDatabase, data_source: AttrDict) -> dict[str, Any]:
    """Soft-deletes a source: sets deleted_at and deprecates its entities and columns, so it
    drops out of the UI and the agent's catalog. Nothing is removed — relationships, metrics and
    glossary links stay as they are, and re-importing the source restores it. Returns the
    deprecated ids per search-index collection so the caller can clean up the index."""
    now = datetime.now(UTC)
    entity_ids = [
        e["_id"]
        for e in db[entity_crud.COLLECTION].find({"data_source_id": data_source.id}, {"_id": 1})
    ]
    column_ids = [
        c["_id"]
        for c in db[entity_column_crud.COLLECTION].find(
            {"entity_id": {"$in": entity_ids}}, {"_id": 1}
        )
    ]

    db[entity_column_crud.COLLECTION].update_many(
        {"_id": {"$in": column_ids}}, {"$set": {"is_deprecated": True, "updated_at": now}}
    )
    db[entity_crud.COLLECTION].update_many(
        {"_id": {"$in": entity_ids}}, {"$set": {"is_deprecated": True, "updated_at": now}}
    )
    data_source_crud.update(db, data_source.id, deleted_at=now)

    return {"entities": sorted(entity_ids), "entity_columns": sorted(column_ids)}
