"""Business metrics for pipeline v4 ("Doanh thu thuần", "Số hội thoại", "Tỷ lệ khách quay lại").

A metric is either
  aggregate  AGG(column) over one table, with its own typed filters on top of the table's default
             filters (count with no column = count rows), or
  ratio      numerator metric / denominator metric × scale (e.g. ×100 for a percentage).

Everything is typed (no SQL fragments) so the v4 compiler can build the SQL. Stored in the
`profile_metrics` collection; deletes are soft (deleted_at).
"""

import re
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.crud_mongo._shared import new_id, utcnow
from src.data_profile import service
from src.data_profile.models import MULTI_VALUE_OPS, NO_VALUE_OPS, Additive, TableKind, TypedFilter
from src.database.models.enums import DefaultAggregation
from src.database.mongodb import AttrDatabase, AttrDict

COLLECTION = "profile_metrics"
_ACTIVE = {"deleted_at": None}
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,62}$")
_PERIOD_RE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")
_NUMERIC_TYPES = {"INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT", "DECIMAL", "DOUBLE", "FLOAT", "NUMERIC"}
# these aggregations can never be added up across groups
_NON_ADDITIVE_AGGS = {DefaultAggregation.AVG, DefaultAggregation.MIN, DefaultAggregation.MAX, DefaultAggregation.COUNT_DISTINCT}


class MetricKind(StrEnum):
    AGGREGATE = "aggregate"
    RATIO = "ratio"


class ReferenceValue(BaseModel):
    period: str          # "2026", "2026-08" or "2026-08-31"
    value: float
    source: str | None = None

    @field_validator("period")
    @classmethod
    def _period_format(cls, v: str) -> str:
        v = v.strip()
        if not _PERIOD_RE.match(v):
            raise ValueError("period must be YYYY, YYYY-MM or YYYY-MM-DD")
        return v


class MetricInput(BaseModel):
    name: str
    display_name: str
    description: str | None = None
    synonyms: list[str] = Field(default_factory=list)
    kind: MetricKind = MetricKind.AGGREGATE

    # aggregate
    entity_id: str | None = None
    aggregation: DefaultAggregation | None = None
    column_id: str | None = None             # None with count = count rows
    filters: list[TypedFilter] = Field(default_factory=list)
    use_table_default_filters: bool = True
    time_column_id: str | None = None        # None = the table's main time column

    # ratio
    numerator_metric_id: str | None = None
    denominator_metric_id: str | None = None
    ratio_scale: float = 1.0                 # 100 for a percentage

    # output
    unit: str | None = None
    additive: Additive | None = None
    decimals: int | None = None
    good_direction: Literal["up", "down", "none"] | None = None

    example_questions: list[str] = Field(default_factory=list)
    reference_values: list[ReferenceValue] = Field(default_factory=list)
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def _name_format(cls, v: str) -> str:
        v = v.strip()
        if not _NAME_RE.match(v):
            raise ValueError("name must be snake_case: lowercase letters, digits and _, starting with a letter")
        return v

    @field_validator("decimals")
    @classmethod
    def _decimals_range(cls, v: int | None) -> int | None:
        if v is not None and not 0 <= v <= 6:
            raise ValueError("decimals must be between 0 and 6")
        return v


class MetricError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


class MetricTableRef(BaseModel):
    entity_id: str
    display_name: str
    physical_path: str
    data_source_name: str
    table_kind: str | None


class MetricChecklist(BaseModel):
    required_done: int
    required_total: int
    recommended_done: int
    recommended_total: int
    missing: list[dict[str, str]]  # {level, field, message}


class MetricItem(MetricInput):
    id: str
    disabled: bool = False          # left out of the pipeline's catalog: the agents can't find or use it
    table: MetricTableRef | None = None
    column_name: str | None = None
    column_type: str | None = None
    numerator_name: str | None = None
    denominator_name: str | None = None
    formula: str
    table_default_filters: list[str] = Field(default_factory=list)
    checklist: MetricChecklist
    search_index: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None


# ── storage ──

def _get(db: AttrDatabase, metric_id: str) -> AttrDict | None:
    return db[COLLECTION].find_one({"_id": metric_id, **_ACTIVE})


def _all(db: AttrDatabase) -> list[AttrDict]:
    return list(db[COLLECTION].find(_ACTIVE))


def get_doc(db: AttrDatabase, metric_id: str) -> AttrDict | None:
    return _get(db, metric_id)


# ── validation ──

def _validate(db: AttrDatabase, data: MetricInput, editing_id: str | None) -> MetricInput:
    errors: list[str] = []
    others = [m for m in _all(db) if m["_id"] != editing_id]
    if any(m["name"] == data.name for m in others):
        errors.append(f"A metric named {data.name!r} already exists")
    if not data.display_name.strip():
        errors.append("Display name is required")

    if data.kind == MetricKind.AGGREGATE:
        entity = entity_crud.get_by_id(db, data.entity_id) if data.entity_id else None
        if entity is None or entity.get("is_deprecated"):
            errors.append("Pick the table the metric is calculated on")
            raise MetricError(errors)
        columns = {c["_id"]: c for c in service.columns_with_json(service.entity_columns(db, entity["_id"]))}
        if data.aggregation is None:
            errors.append("Pick how to aggregate (sum, count…)")
        if data.column_id is not None and data.column_id not in columns:
            errors.append("The measured column is not in the chosen table")
        if data.aggregation is not None and data.aggregation != DefaultAggregation.COUNT and data.column_id is None:
            errors.append(f"{data.aggregation} needs a column")
        col = columns.get(data.column_id) if data.column_id else None
        if (
            col is not None
            and data.aggregation in (DefaultAggregation.SUM, DefaultAggregation.AVG)
            and str(col.get("data_type", "")).upper() not in _NUMERIC_TYPES
        ):
            errors.append(f"{data.aggregation} needs a numeric column; {col['physical_name']} is {col.get('data_type')}")
        if data.time_column_id is not None and data.time_column_id not in columns:
            errors.append("The time column is not in the chosen table")
        for i, f in enumerate(data.filters, start=1):
            c = columns.get(f.column_id)
            if c is None:
                errors.append(f"Filter {i}: the column is not in the chosen table")
                continue
            if f.op in NO_VALUE_OPS and f.values:
                errors.append(f"Filter {i} on {c['physical_name']}: '{f.op}' takes no value")
            elif f.op in MULTI_VALUE_OPS and not f.values:
                errors.append(f"Filter {i} on {c['physical_name']}: '{f.op}' needs at least one value")
            elif f.op not in NO_VALUE_OPS and f.op not in MULTI_VALUE_OPS and len(f.values) != 1:
                errors.append(f"Filter {i} on {c['physical_name']}: '{f.op}' needs exactly one value")
            cp = service.column_profile(c)
            if cp.value_catalog_complete and cp.value_catalog and f.op not in NO_VALUE_OPS:
                known = {v.value for v in cp.value_catalog}
                unknown = [str(v) for v in f.values if str(v) not in known]
                if unknown:
                    errors.append(f"Filter {i} on {c['physical_name']}: {', '.join(unknown)} not in the column's value list")
        # clear ratio fields
        data = data.model_copy(update={"numerator_metric_id": None, "denominator_metric_id": None, "ratio_scale": 1.0})
        if data.aggregation in _NON_ADDITIVE_AGGS:
            data = data.model_copy(update={"additive": Additive.NONE})
    else:
        by_id = {m["_id"]: m for m in others}
        for side, mid in (("Numerator", data.numerator_metric_id), ("Denominator", data.denominator_metric_id)):
            if not mid or mid not in by_id:
                errors.append(f"{side}: pick an existing metric")
        if data.numerator_metric_id and data.numerator_metric_id == data.denominator_metric_id:
            errors.append("Numerator and denominator must be different metrics")
        if editing_id and editing_id in (data.numerator_metric_id, data.denominator_metric_id):
            errors.append("A ratio cannot use itself")
        if editing_id and not errors and _uses(db, data.numerator_metric_id, editing_id) | _uses(db, data.denominator_metric_id, editing_id):
            errors.append("This would make a loop: a metric used here is built from this metric")
        if data.ratio_scale <= 0:
            errors.append("Scale must be greater than 0")
        data = data.model_copy(update={
            "entity_id": None, "aggregation": None, "column_id": None, "filters": [],
            "time_column_id": None, "additive": Additive.NONE,
        })
    if errors:
        raise MetricError(errors)
    return data


def _uses(db: AttrDatabase, metric_id: str | None, target: str, depth: int = 0) -> bool:
    """True if metric_id is target or is (indirectly) built from target."""
    if metric_id is None or depth > 10:
        return False
    if metric_id == target:
        return True
    doc = _get(db, metric_id)
    if doc is None or doc.get("kind") != MetricKind.RATIO:
        return False
    return _uses(db, doc.get("numerator_metric_id"), target, depth + 1) or _uses(
        db, doc.get("denominator_metric_id"), target, depth + 1
    )


# ── presentation ──

def _filter_text(f: dict[str, Any], names: dict[str, str]) -> str:
    col = names.get(f["column_id"], "?")
    if f["op"] in NO_VALUE_OPS:
        return f"{col} {'is empty' if f['op'] == 'is_null' else 'is not empty'}"
    return f"{col} {f['op']} {', '.join(map(str, f.get('values') or []))}"


def _checklist(doc: dict[str, Any]) -> MetricChecklist:
    items: list[tuple[bool, str, str, str]] = [
        (bool(doc.get("description")), "required", "description", "Describe what the metric measures"),
        (bool(doc.get("unit")), "required", "unit", "Set the unit"),
        (bool(doc.get("synonyms")), "recommended", "synonyms", "Add other names people use"),
        (bool(doc.get("example_questions")), "recommended", "example_questions", "Add example questions"),
        (bool(doc.get("reference_values")), "recommended", "reference_values", "Add a known value to check answers against"),
        (doc.get("good_direction") is not None, "recommended", "good_direction", "Say whether higher is better"),
    ]
    if doc.get("kind") == MetricKind.AGGREGATE:
        items.append((doc.get("additive") is not None, "required", "additive", "Say whether it can be summed"))
    req = [i for i in items if i[1] == "required"]
    rec = [i for i in items if i[1] == "recommended"]
    return MetricChecklist(
        required_done=sum(i[0] for i in req), required_total=len(req),
        recommended_done=sum(i[0] for i in rec), recommended_total=len(rec),
        missing=[{"level": lvl, "field": f, "message": m} for ok, lvl, f, m in items if not ok],
    )


def to_item(db: AttrDatabase, doc: dict[str, Any], by_id: dict[str, dict[str, Any]] | None = None) -> MetricItem:
    by_id = by_id if by_id is not None else {m["_id"]: m for m in _all(db)}
    data = MetricInput.model_validate(doc)
    table = column_name = column_type = None
    table_defaults: list[str] = []
    formula = ""
    if data.kind == MetricKind.AGGREGATE and data.entity_id:
        entity = entity_crud.get_by_id(db, data.entity_id)
        if entity is not None:
            source = data_source_crud.get_by_id(db, entity["data_source_id"])
            profile = service.entity_profile(entity)
            table = MetricTableRef(
                entity_id=entity["_id"],
                display_name=entity.get("display_name") or entity["physical_name"],
                physical_path=entity["physical_path"],
                data_source_name=source["name"] if source else "?",
                table_kind=profile.table_kind,
            )
            columns = {c["_id"]: c for c in service.columns_with_json(service.entity_columns(db, entity["_id"]))}
            names = {cid: c["physical_name"] for cid, c in columns.items()}
            col = columns.get(data.column_id) if data.column_id else None
            column_name = col["physical_name"] if col else None
            column_type = col.get("data_type") if col else None
            table_defaults = [_filter_text(f.model_dump(), names) for f in profile.default_filters]
            agg = (data.aggregation or "?").upper().replace("COUNT_DISTINCT", "COUNT DISTINCT")
            formula = f"{agg}({entity['physical_name']}.{column_name})" if column_name else f"{agg}(*) of {entity['physical_name']}"
            conds = [_filter_text(f.model_dump(), names) for f in data.filters]
            if conds:
                formula += " where " + " and ".join(conds)
            if data.use_table_default_filters and table_defaults:
                formula += " + table default filters"
            if profile.table_kind == TableKind.SNAPSHOT:
                formula += " · on the last snapshot date of the period"
    elif data.kind == MetricKind.RATIO:
        num = by_id.get(data.numerator_metric_id or "")
        den = by_id.get(data.denominator_metric_id or "")
        formula = f"{num['name'] if num else '?'} / {den['name'] if den else '?'}"
        if data.ratio_scale != 1:
            formula += f" × {data.ratio_scale:g}"
    return MetricItem(
        **data.model_dump(),
        id=doc["_id"],
        table=table,
        column_name=column_name,
        column_type=column_type,
        numerator_name=(by_id.get(data.numerator_metric_id or "") or {}).get("name"),
        denominator_name=(by_id.get(data.denominator_metric_id or "") or {}).get("name"),
        formula=formula,
        table_default_filters=table_defaults,
        checklist=_checklist(doc),
        search_index=doc.get("search_index") or {"status": "never"},
        disabled=doc.get("disabled_at") is not None,
        created_at=doc.get("created_at"),
        updated_at=doc.get("updated_at"),
    )


def list_items(db: AttrDatabase) -> list[MetricItem]:
    docs = _all(db)
    by_id = {m["_id"]: m for m in docs}
    items = [to_item(db, d, by_id) for d in docs]
    return sorted(items, key=lambda i: i.created_at.timestamp() if i.created_at else float("-inf"), reverse=True)


# ── writing ──

def create(db: AttrDatabase, data: MetricInput) -> AttrDict:
    data = _validate(db, data, None)
    doc = {"_id": new_id(), **data.model_dump(mode="json"), "deleted_at": None,
           "created_at": utcnow(), "updated_at": utcnow()}
    db[COLLECTION].insert_one(doc)
    return _get(db, doc["_id"])  # type: ignore[return-value]


def update(db: AttrDatabase, metric_id: str, data: MetricInput) -> AttrDict:
    data = _validate(db, data, metric_id)
    db[COLLECTION].update_one({"_id": metric_id}, {"$set": {**data.model_dump(mode="json"), "updated_at": utcnow()}})
    return _get(db, metric_id)  # type: ignore[return-value]


def used_by(db: AttrDatabase, metric_id: str) -> list[str]:
    """Names of ratio metrics built from this metric."""
    return [
        m["name"] for m in _all(db)
        if m.get("kind") == MetricKind.RATIO and metric_id in (m.get("numerator_metric_id"), m.get("denominator_metric_id"))
    ]


def soft_delete(db: AttrDatabase, metric_id: str) -> None:
    users = used_by(db, metric_id) + [
        f"glossary term “{t['term']}”"
        for t in db["profile_glossary"].find({"metric_id": metric_id, **_ACTIVE}, {"term": 1})
    ]
    if users:
        raise MetricError([f"Used by {', '.join(users)}: change or delete those first"])
    db[COLLECTION].update_one({"_id": metric_id}, {"$set": {"deleted_at": utcnow(), "updated_at": utcnow()}})


def set_index_status(db: AttrDatabase, metric_id: str, status: str, error: str | None = None) -> None:
    db[COLLECTION].update_one(
        {"_id": metric_id},
        {"$set": {"search_index": {"status": status, "error": error, "updated_at": utcnow().isoformat()}}},
    )
