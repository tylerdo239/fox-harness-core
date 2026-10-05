from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict
from src.security import role

COLLECTION = "business_glossary"


def _visible(db: AttrDatabase, docs: list) -> list:
    """A term is visible to a non-admin only if every table it relates to is (its SQL fragments name them)."""
    docs = [d for d in docs if d is not None]
    if role.is_admin() or not docs:
        return docs
    entities = role.visible_entity_ids(db) or set()
    return [d for d in docs if all(e in entities for e in (d.get("related_entity_ids") or []))]


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return _visible(db, list(db[COLLECTION].find({})))


def get_by_id(db: AttrDatabase, term_id: str) -> AttrDict | None:
    kept = _visible(db, [db[COLLECTION].find_one({"_id": term_id})])
    return kept[0] if kept else None


def list_by_ids(db: AttrDatabase, term_ids: list[str]) -> list[AttrDict]:
    return _visible(db, list(db[COLLECTION].find({"_id": {"$in": term_ids}})))


def create(
    db: AttrDatabase,
    *,
    term: str,
    synonyms: list[str],
    definition_text: str,
    sql_expressions: list[str],
    related_entity_ids: list[str],
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "term": term,
        "synonyms": synonyms,
        "definition_text": definition_text,
        "sql_expressions": sql_expressions,
        "related_entity_ids": related_entity_ids,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[COLLECTION].insert_one(doc)
    return get_by_id(db, doc["_id"])


def update(db: AttrDatabase, term_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[COLLECTION].update_one({"_id": term_id}, {"$set": fields})
    return get_by_id(db, term_id)


def delete(db: AttrDatabase, term_id: str) -> bool:
    result = db[COLLECTION].delete_one({"_id": term_id})
    return result.deleted_count > 0
