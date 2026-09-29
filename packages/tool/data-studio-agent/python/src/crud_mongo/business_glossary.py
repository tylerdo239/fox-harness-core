from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict

COLLECTION = "business_glossary"


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find({}))


def get_by_id(db: AttrDatabase, term_id: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"_id": term_id})


def list_by_ids(db: AttrDatabase, term_ids: list[str]) -> list[AttrDict]:
    return list(db[COLLECTION].find({"_id": {"$in": term_ids}}))


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
