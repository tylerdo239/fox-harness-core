from src.crud_mongo._shared import new_id, utcnow
from src.database.mongodb import AttrDatabase, AttrDict

DASHBOARD_COLLECTION = "dashboards"
WIDGET_COLLECTION = "dashboard_widgets"


def list_all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[DASHBOARD_COLLECTION].find({}).sort("updated_at", -1))


def get_by_id(db: AttrDatabase, dashboard_id: str) -> AttrDict | None:
    return db[DASHBOARD_COLLECTION].find_one({"_id": dashboard_id})


def create(db: AttrDatabase, *, title: str, description: str) -> AttrDict:
    doc = {
        "_id": new_id(),
        "title": title,
        "description": description,
        "appearance_json": {},
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[DASHBOARD_COLLECTION].insert_one(doc)
    return get_by_id(db, doc["_id"])


def update(db: AttrDatabase, dashboard_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[DASHBOARD_COLLECTION].update_one({"_id": dashboard_id}, {"$set": fields})
    return get_by_id(db, dashboard_id)


def delete(db: AttrDatabase, dashboard_id: str) -> bool:
    delete_widgets_by_dashboard(db, dashboard_id)
    result = db[DASHBOARD_COLLECTION].delete_one({"_id": dashboard_id})
    return result.deleted_count > 0


def list_widgets(db: AttrDatabase, dashboard_id: str) -> list[AttrDict]:
    return list(db[WIDGET_COLLECTION].find({"dashboard_id": dashboard_id}).sort("seq", 1))


def count_widgets(db: AttrDatabase, dashboard_id: str) -> int:
    return db[WIDGET_COLLECTION].count_documents({"dashboard_id": dashboard_id})


def get_widget(db: AttrDatabase, widget_id: str) -> AttrDict | None:
    return db[WIDGET_COLLECTION].find_one({"_id": widget_id})


def create_widget(
    db: AttrDatabase,
    *,
    dashboard_id: str,
    seq: int,
    kind: str,
    chart_id: str | None,
    x: int,
    y: int,
    w: int,
    h: int,
    title_override: str | None = None,
    note: str | None = None,
    text: str | None = None,
) -> AttrDict:
    doc = {
        "_id": new_id(),
        "dashboard_id": dashboard_id,
        "seq": seq,
        "kind": kind,
        "chart_id": chart_id,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "title_override": title_override,
        "note": note,
        "text": text,
        "config_json": {},
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    db[WIDGET_COLLECTION].insert_one(doc)
    return get_widget(db, doc["_id"])


def update_widget(db: AttrDatabase, widget_id: str, **fields) -> AttrDict | None:
    fields["updated_at"] = utcnow()
    db[WIDGET_COLLECTION].update_one({"_id": widget_id}, {"$set": fields})
    return get_widget(db, widget_id)


def delete_widget(db: AttrDatabase, widget_id: str) -> None:
    db[WIDGET_COLLECTION].delete_one({"_id": widget_id})


def delete_widgets_by_dashboard(db: AttrDatabase, dashboard_id: str) -> None:
    db[WIDGET_COLLECTION].delete_many({"dashboard_id": dashboard_id})
