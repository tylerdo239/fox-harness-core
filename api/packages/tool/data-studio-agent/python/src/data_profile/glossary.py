"""Business glossary for pipeline v4: words people use that need a fixed meaning.

  segment     a named set of rows on one table, as typed filters ("khách VIP" = segment = VIP)
  metric      another name for an existing metric ("doanh số" → net_revenue)
  definition  a convention written in words for the agent to follow ("tăng trưởng" = % vs the
              previous period)

Everything is typed (no SQL fragments). Stored in `profile_glossary`; deletes are soft.
"""

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator

from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.crud_mongo._shared import new_id, utcnow
from src.data_profile import metrics as metric_service
from src.data_profile import service
from src.data_profile.models import NO_VALUE_OPS, TypedFilter
from src.database.mongodb import AttrDatabase, AttrDict

COLLECTION = "profile_glossary"
_ACTIVE = {"deleted_at": None}


class TermKind(StrEnum):
    SEGMENT = "segment"
    METRIC = "metric"
    DEFINITION = "definition"


class GlossaryInput(BaseModel):
    term: str
    synonyms: list[str] = Field(default_factory=list)
    definition: str | None = None
    kind: TermKind = TermKind.SEGMENT

    # segment
    entity_id: str | None = None
    filters: list[TypedFilter] = Field(default_factory=list)

    # metric
    metric_id: str | None = None

    # definition: tables the convention is about (helps the agent find it)
    related_entity_ids: list[str] = Field(default_factory=list)

    example_questions: list[str] = Field(default_factory=list)
    notes: str | None = None

    @field_validator("term")
    @classmethod
    def _term_not_blank(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("term must not be empty")
        return v


class GlossaryError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


class TableRef(BaseModel):
    entity_id: str
    display_name: str
    physical_path: str
    data_source_name: str


class GlossaryItem(GlossaryInput):
    id: str
    disabled: bool = False          # left out of the pipeline's catalog: the agents can't find or use it
    table: TableRef | None = None
    related_tables: list[TableRef] = Field(default_factory=list)
    metric_name: str | None = None
    metric_display_name: str | None = None
    meaning: str  # one-line summary, e.g. "segment = VIP on customers"
    checklist: dict[str, Any]
    search_index: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None


# ── storage ──

def get_doc(db: AttrDatabase, term_id: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"_id": term_id, **_ACTIVE})


def _all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find(_ACTIVE))


def _table_ref(db: AttrDatabase, entity_id: str | None) -> TableRef | None:
    entity = entity_crud.get_by_id(db, entity_id) if entity_id else None
    if entity is None or entity.get("is_deprecated"):
        return None
    source = data_source_crud.get_by_id(db, entity["data_source_id"])
    if source is None or source.get("deleted_at"):
        return None
    return TableRef(
        entity_id=entity["_id"],
        display_name=entity.get("display_name") or entity["physical_name"],
        physical_path=entity["physical_path"],
        data_source_name=source["name"],
    )


# ── validation ──

def _validate(db: AttrDatabase, data: GlossaryInput, editing_id: str | None) -> GlossaryInput:
    errors: list[str] = []
    wanted = data.term.lower()
    for other in _all(db):
        if other["_id"] != editing_id and other["term"].lower() == wanted:
            errors.append(f"The term {data.term!r} already exists")
    if not (data.definition or "").strip():
        errors.append("Write what the term means")

    if data.kind == TermKind.SEGMENT:
        if _table_ref(db, data.entity_id) is None:
            errors.append("Pick the table the segment is on")
            raise GlossaryError(errors)
        if not data.filters:
            errors.append("A segment needs at least one filter")
        columns = {c["_id"]: c for c in service.columns_with_json(service.entity_columns(db, data.entity_id))}
        for i, f in enumerate(data.filters, start=1):
            errors += service._filter_errors(f, columns, f"filter {i}")
        data = data.model_copy(update={"metric_id": None, "related_entity_ids": []})
    elif data.kind == TermKind.METRIC:
        if not data.metric_id or metric_service.get_doc(db, data.metric_id) is None:
            errors.append("Pick the metric this term means")
        data = data.model_copy(update={"entity_id": None, "filters": [], "related_entity_ids": []})
    else:
        bad = [eid for eid in data.related_entity_ids if _table_ref(db, eid) is None]
        if bad:
            errors.append("A related table no longer exists")
        data = data.model_copy(update={"entity_id": None, "filters": [], "metric_id": None})
    if errors:
        raise GlossaryError(errors)
    return data


# ── presentation ──

def _filter_text(f: TypedFilter, names: dict[str, str]) -> str:
    col = names.get(f.column_id, "?")
    if f.op in NO_VALUE_OPS:
        return f"{col} {'is empty' if f.op == 'is_null' else 'is not empty'}"
    op = {"not_in": "not in", "!=": "≠"}.get(f.op.value, f.op.value)
    return f"{col} {op} {', '.join(map(str, f.values))}"


def _checklist(doc: dict[str, Any]) -> dict[str, Any]:
    items = [
        (bool(doc.get("definition")), "required", "definition", "Write what the term means"),
        (bool(doc.get("synonyms")), "recommended", "synonyms", "Add other ways people say it"),
        (bool(doc.get("example_questions")), "recommended", "example_questions", "Add example questions"),
    ]
    req = [i for i in items if i[1] == "required"]
    rec = [i for i in items if i[1] == "recommended"]
    return {
        "required_done": sum(i[0] for i in req), "required_total": len(req),
        "recommended_done": sum(i[0] for i in rec), "recommended_total": len(rec),
        "missing": [{"level": lvl, "field": f, "message": m} for ok, lvl, f, m in items if not ok],
    }


def to_item(db: AttrDatabase, doc: dict[str, Any]) -> GlossaryItem:
    data = GlossaryInput.model_validate(doc)
    table = metric_name = metric_display = None
    meaning = ""
    if data.kind == TermKind.SEGMENT:
        table = _table_ref(db, data.entity_id)
        names = {c["_id"]: c["physical_name"] for c in service.columns_with_json(service.entity_columns(db, data.entity_id))} if table else {}
        conds = " and ".join(_filter_text(f, names) for f in data.filters)
        meaning = f"rows of {table.physical_path if table else '?'} where {conds or '?'}"
    elif data.kind == TermKind.METRIC:
        m = metric_service.get_doc(db, data.metric_id) if data.metric_id else None
        metric_name = m["name"] if m else None
        metric_display = m.get("display_name") if m else None
        meaning = f"the metric {metric_name or '?'}"
    else:
        meaning = (data.definition or "").strip().splitlines()[0][:160] if data.definition else ""
    related = [r for r in (_table_ref(db, eid) for eid in data.related_entity_ids) if r is not None]
    return GlossaryItem(
        **data.model_dump(), id=doc["_id"], table=table, related_tables=related,
        metric_name=metric_name, metric_display_name=metric_display, meaning=meaning,
        checklist=_checklist(doc), search_index=doc.get("search_index") or {"status": "never"},
        disabled=doc.get("disabled_at") is not None,
        created_at=doc.get("created_at"), updated_at=doc.get("updated_at"),
    )


def list_items(db: AttrDatabase) -> list[GlossaryItem]:
    items = [to_item(db, d) for d in _all(db)]
    return sorted(items, key=lambda i: i.created_at.timestamp() if i.created_at else float("-inf"), reverse=True)


# ── writing ──

def create(db: AttrDatabase, data: GlossaryInput) -> AttrDict:
    data = _validate(db, data, None)
    doc = {"_id": new_id(), **data.model_dump(mode="json"), "deleted_at": None,
           "created_at": utcnow(), "updated_at": utcnow()}
    db[COLLECTION].insert_one(doc)
    return get_doc(db, doc["_id"])  # type: ignore[return-value]


def update(db: AttrDatabase, term_id: str, data: GlossaryInput) -> AttrDict:
    data = _validate(db, data, term_id)
    db[COLLECTION].update_one({"_id": term_id}, {"$set": {**data.model_dump(mode="json"), "updated_at": utcnow()}})
    return get_doc(db, term_id)  # type: ignore[return-value]


def soft_delete(db: AttrDatabase, term_id: str) -> None:
    db[COLLECTION].update_one({"_id": term_id}, {"$set": {"deleted_at": utcnow(), "updated_at": utcnow()}})


def set_index_status(db: AttrDatabase, term_id: str, status: str, error: str | None = None) -> None:
    db[COLLECTION].update_one(
        {"_id": term_id},
        {"$set": {"search_index": {"status": status, "error": error, "updated_at": utcnow().isoformat()}}},
    )
