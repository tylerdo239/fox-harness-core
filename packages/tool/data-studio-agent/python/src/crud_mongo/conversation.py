from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict

CONVERSATION_COLLECTION = "conversations"
MESSAGE_COLLECTION = "messages"
QUERY_RESULT_COLLECTION = "query_results"
CHART_COLLECTION = "charts"


def list_conversations(db: AttrDatabase) -> list[AttrDict]:
    return list(db[CONVERSATION_COLLECTION].find({}).sort("updated_at", -1))


def get_conversation(db: AttrDatabase, conversation_id: str) -> AttrDict | None:
    return db[CONVERSATION_COLLECTION].find_one({"_id": conversation_id})


def list_messages(db: AttrDatabase, conversation_id: str) -> list[AttrDict]:
    return list(db[MESSAGE_COLLECTION].find({"conversation_id": conversation_id}).sort("seq", 1))


def get_message(db: AttrDatabase, message_id: str) -> AttrDict | None:
    return db[MESSAGE_COLLECTION].find_one({"_id": message_id})


def list_query_results(db: AttrDatabase, message_id: str) -> list[AttrDict]:
    return list(db[QUERY_RESULT_COLLECTION].find({"message_id": message_id}).sort("seq", 1))


def get_query_result(db: AttrDatabase, query_result_id: str) -> AttrDict | None:
    return db[QUERY_RESULT_COLLECTION].find_one({"_id": query_result_id})


def list_charts(db: AttrDatabase, query_result_id: str) -> list[AttrDict]:
    return list(db[CHART_COLLECTION].find({"query_result_id": query_result_id}))


def list_all_charts(db: AttrDatabase) -> list[AttrDict]:
    return list(db[CHART_COLLECTION].find({}).sort("created_at", -1))


def get_chart(db: AttrDatabase, chart_id: str) -> AttrDict | None:
    return db[CHART_COLLECTION].find_one({"_id": chart_id})


def update_chart(db: AttrDatabase, chart_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[CHART_COLLECTION].update_one({"_id": chart_id}, {"$set": fields})
    return get_chart(db, chart_id)


def create_conversation(db: AttrDatabase, *, title: str | None) -> AttrDict:
    doc = {
        "_id": new_id(),
        "title": title,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[CONVERSATION_COLLECTION].insert_one(doc)
    return get_conversation(db, doc["_id"])


def update_conversation(db: AttrDatabase, conversation_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[CONVERSATION_COLLECTION].update_one({"_id": conversation_id}, {"$set": fields})
    return get_conversation(db, conversation_id)


def create_message(
    db: AttrDatabase,
    *,
    conversation_id: str,
    seq: int,
    role: str,
    content: str = "",
    question: str | None = None,
    answer_markdown: str | None = None,
    is_decomposed: bool = False,
    follow_up_questions: list[str] | None = None,
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "conversation_id": conversation_id,
        "seq": seq,
        "role": role,
        "content": content,
        "question": question,
        "answer_markdown": answer_markdown,
        "is_decomposed": is_decomposed,
        "follow_up_questions_json": follow_up_questions or [],
        "created_at": utcnow(),
    }
    db[MESSAGE_COLLECTION].insert_one(doc)
    return get_message(db, doc["_id"])


def next_message_seq(db: AttrDatabase, conversation_id: str) -> int:
    """0 for the first message in a conversation; otherwise one past the highest seq so far."""
    last = list(
        db[MESSAGE_COLLECTION]
        .find({"conversation_id": conversation_id})
        .sort("seq", -1)
        .limit(1)
    )
    return 0 if not last else last[0]["seq"] + 1


def create_query_result(
    db: AttrDatabase,
    *,
    message_id: str,
    seq: int,
    sub_id: str | None = None,
    sub_question: str | None = None,
    sql: str | None = None,
    row_count: int = 0,
    rows: list[dict] | None = None,
    display_columns: list[dict] | None = None,
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "message_id": message_id,
        "seq": seq,
        "sub_id": sub_id,
        "sub_question": sub_question,
        "sql": sql,
        "row_count": row_count,
        "rows_json": rows or [],
        "display_columns_json": display_columns or [],
        "created_at": utcnow(),
    }
    db[QUERY_RESULT_COLLECTION].insert_one(doc)
    return get_query_result(db, doc["_id"])


def create_chart(
    db: AttrDatabase,
    *,
    query_result_id: str,
    type: str,
    title: str = "",
    description: str = "",
    x: str | None = None,
    y: list[str] | None = None,
    value_field: str | None = None,
    recommended: bool = False,
    rows: list[dict] | None = None,
    transform_code: str = "",
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "query_result_id": query_result_id,
        "type": type,
        "title": title,
        "description": description,
        "x": x,
        "y_json": y or [],
        "value_field": value_field,
        "recommended": recommended,
        "rows_json": rows or [],
        "transform_code": transform_code,
        "title_override": None,
        "x_override": None,
        "y_override_json": None,
        "color_overrides_json": {},
        "label_overrides_json": {},
        "is_pinned": False,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[CHART_COLLECTION].insert_one(doc)
    return get_chart(db, doc["_id"])
