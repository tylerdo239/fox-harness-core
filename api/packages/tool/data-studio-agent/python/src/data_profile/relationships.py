"""Relationships between tables for pipeline v4, including tables in different data sources.

Dremio federates sources, so a join across sources is valid SQL; the risk is keys that don't
match (VARCHAR '0012' vs INTEGER 12, case, padding). Type mismatches are reported as warnings,
not errors, because a person may know the values line up.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.crud_mongo import relationship as relationship_crud
from src.data_profile import service
from src.data_profile.models import RelationshipProfile
from src.database.models.enums import Cardinality, JoinType
from src.database.mongodb import AttrDatabase

_TYPE_FAMILY = {
    "VARCHAR": "text", "CHAR": "text", "STRING": "text",
    "INTEGER": "integer", "INT": "integer", "BIGINT": "integer", "SMALLINT": "integer", "TINYINT": "integer",
    "DECIMAL": "number", "DOUBLE": "number", "FLOAT": "number", "NUMERIC": "number",
    "DATE": "date", "TIMESTAMP": "timestamp", "TIMESTAMPTZ": "timestamp", "TIME": "time",
    "BOOLEAN": "boolean",
}
_NUMERIC = {"integer", "number"}


class RelationshipError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


class TableRef(BaseModel):
    entity_id: str
    display_name: str
    physical_path: str
    data_source_id: str
    data_source_name: str


class PairInfo(BaseModel):
    from_column_id: str
    from_column: str
    from_type: str
    to_column_id: str
    to_column: str
    to_type: str


class RelationshipItem(BaseModel):
    id: str
    from_table: TableRef
    to_table: TableRef
    cardinality: Cardinality
    join_type_default: JoinType
    pairs: list[PairInfo]
    profile: RelationshipProfile
    cross_source: bool
    warnings: list[str] = Field(default_factory=list)
    created_at: datetime | None = None


class PairInput(BaseModel):
    from_column_id: str
    to_column_id: str


class RelationshipInput(BaseModel):
    from_entity_id: str
    to_entity_id: str
    cardinality: Cardinality
    join_type_default: JoinType
    pairs: list[PairInput]
    profile: RelationshipProfile = Field(default_factory=RelationshipProfile)


class TableOption(BaseModel):
    entity_id: str
    display_name: str
    physical_name: str
    physical_path: str
    entity_type: str
    data_source_id: str
    data_source_name: str


class ColumnOption(BaseModel):
    id: str
    physical_name: str
    display_name: str
    data_type: str
    role: str | None
    is_grain_key: bool


def _family(data_type: str | None) -> str:
    return _TYPE_FAMILY.get(str(data_type or "").upper(), str(data_type or "?").lower())


def pair_warnings(from_col: dict[str, Any], to_col: dict[str, Any]) -> list[str]:
    a, b = _family(from_col.get("data_type")), _family(to_col.get("data_type"))
    if a == b or {a, b} <= _NUMERIC:
        return []
    label = f"{from_col['physical_name']} ({from_col.get('data_type')}) = {to_col['physical_name']} ({to_col.get('data_type')})"
    if "text" in (a, b) and ({a, b} - {"text"}) <= _NUMERIC:
        return [f"{label}: text vs number — check the values match exactly (leading zeros, spaces)"]
    return [f"{label}: different types — the join may fail or match nothing"]


# ── reading ──

def _active_sources(db: AttrDatabase) -> dict[str, dict[str, Any]]:
    return {s["_id"]: s for s in data_source_crud.list_active(db)}


def table_options(db: AttrDatabase) -> list[TableOption]:
    sources = _active_sources(db)
    options = [
        TableOption(
            entity_id=e["_id"],
            display_name=e.get("display_name") or e["physical_name"],
            physical_name=e["physical_name"],
            physical_path=e["physical_path"],
            entity_type=e.get("entity_type") or "table",
            data_source_id=e["data_source_id"],
            data_source_name=sources[e["data_source_id"]]["name"],
        )
        for e in entity_crud.list_active(db)
        if e["data_source_id"] in sources
    ]
    return sorted(options, key=lambda o: (o.data_source_name.lower(), o.display_name.lower()))


def column_options(db: AttrDatabase, entity: dict[str, Any]) -> list[ColumnOption]:
    grain = set(service.entity_profile(entity).grain_key_column_ids)
    return [
        ColumnOption(
            id=c["_id"],
            physical_name=c["physical_name"],
            display_name=c.get("display_name") or c["physical_name"],
            data_type=c.get("data_type") or "UNKNOWN",
            role=c.get("role"),
            is_grain_key=c["_id"] in grain,
        )
        for c in service.entity_columns(db, entity["_id"])
    ]


def list_items(db: AttrDatabase) -> list[RelationshipItem]:
    rels = relationship_crud.list_all(db)
    if not rels:
        return []
    sources = _active_sources(db)
    entity_ids = {r["from_entity_id"] for r in rels} | {r["to_entity_id"] for r in rels}
    entities = {e["_id"]: e for e in entity_crud.list_by_ids(db, list(entity_ids))}
    pairs = relationship_crud.list_column_pairs_by_relationship_ids(db, [r["_id"] for r in rels])
    col_ids = {p["from_column_id"] for p in pairs} | {p["to_column_id"] for p in pairs}
    columns = {c["_id"]: c for c in entity_column_crud.list_by_ids(db, list(col_ids))}

    def table_ref(entity_id: str) -> TableRef | None:
        e = entities.get(entity_id)
        if e is None or e.get("is_deprecated") or e["data_source_id"] not in sources:
            return None
        return TableRef(
            entity_id=entity_id,
            display_name=e.get("display_name") or e["physical_name"],
            physical_path=e["physical_path"],
            data_source_id=e["data_source_id"],
            data_source_name=sources[e["data_source_id"]]["name"],
        )

    items = []
    for rel in rels:
        from_ref, to_ref = table_ref(rel["from_entity_id"]), table_ref(rel["to_entity_id"])
        if from_ref is None or to_ref is None:
            continue  # a side was removed from Dremio or its source was deleted
        infos, warnings = [], []
        for p in sorted((p for p in pairs if p["relationship_id"] == rel["_id"]), key=lambda p: p.get("seq", 0)):
            fc, tc = columns.get(p["from_column_id"]), columns.get(p["to_column_id"])
            if fc is None or tc is None:
                continue
            infos.append(PairInfo(
                from_column_id=fc["_id"], from_column=fc["physical_name"], from_type=fc.get("data_type") or "?",
                to_column_id=tc["_id"], to_column=tc["physical_name"], to_type=tc.get("data_type") or "?",
            ))
            warnings += pair_warnings(fc, tc)
            if fc.get("is_deprecated") or tc.get("is_deprecated"):
                warnings.append(f"{fc['physical_name']} = {tc['physical_name']}: a column no longer exists in Dremio")
        items.append(RelationshipItem(
            id=rel["_id"], from_table=from_ref, to_table=to_ref,
            cardinality=rel["cardinality"], join_type_default=rel["join_type_default"],
            pairs=infos, profile=service.relationship_profile(rel),
            cross_source=from_ref.data_source_id != to_ref.data_source_id, warnings=warnings,
            created_at=rel.get("created_at"),
        ))
    # newest first; relationships without a timestamp go last
    return sorted(items, key=lambda i: i.created_at.timestamp() if i.created_at else float("-inf"), reverse=True)


def get_item(db: AttrDatabase, relationship_id: str) -> RelationshipItem | None:
    return next((i for i in list_items(db) if i.id == relationship_id), None)


# ── writing ──

def _validate(db: AttrDatabase, data: RelationshipInput, editing_id: str | None) -> None:
    errors: list[str] = []
    sources = _active_sources(db)
    tables = {}
    for side, eid in (("From", data.from_entity_id), ("To", data.to_entity_id)):
        e = entity_crud.get_by_id(db, eid)
        if e is None or e.get("is_deprecated") or e["data_source_id"] not in sources:
            errors.append(f"{side} table not found")
        tables[side] = e
    if errors:
        raise RelationshipError(errors)

    if not data.pairs:
        errors.append("Add at least one pair of key columns")
    from_cols = {c["_id"] for c in service.entity_columns(db, data.from_entity_id)}
    to_cols = {c["_id"] for c in service.entity_columns(db, data.to_entity_id)}
    seen = set()
    for i, p in enumerate(data.pairs, start=1):
        if p.from_column_id not in from_cols:
            errors.append(f"Pair {i}: the left column is not in the From table")
        if p.to_column_id not in to_cols:
            errors.append(f"Pair {i}: the right column is not in the To table")
        if data.from_entity_id == data.to_entity_id and p.from_column_id == p.to_column_id:
            errors.append(f"Pair {i}: a column cannot be joined to itself")
        key = (p.from_column_id, p.to_column_id)
        if key in seen:
            errors.append(f"Pair {i}: the same pair is listed twice")
        seen.add(key)
    if errors:
        raise RelationshipError(errors)

    # the same join already defined (in either direction)?
    wanted = frozenset(seen)
    reverse = frozenset((b, a) for a, b in seen)
    for other in relationship_crud.list_touching_entity_ids(db, [data.from_entity_id]):
        if other["_id"] == editing_id:
            continue
        ends = {other["from_entity_id"], other["to_entity_id"]}
        if ends != {data.from_entity_id, data.to_entity_id}:
            continue
        existing = frozenset(
            (p["from_column_id"], p["to_column_id"]) for p in relationship_crud.list_column_pairs(db, other["_id"])
        )
        if existing in (wanted, reverse):
            raise RelationshipError(["This relationship already exists"])


def _write_pairs(db: AttrDatabase, relationship_id: str, pairs: list[PairInput]) -> None:
    relationship_crud.delete_column_pairs_by_relationship(db, relationship_id)  # soft: old pairs keep deleted_at
    for seq, p in enumerate(pairs):
        relationship_crud.create_column_pair(
            db, relationship_id=relationship_id,
            from_column_id=p.from_column_id, to_column_id=p.to_column_id, seq=seq,
        )


def create(db: AttrDatabase, data: RelationshipInput) -> RelationshipItem:
    _validate(db, data, None)
    rel = relationship_crud.create(
        db, from_entity_id=data.from_entity_id, to_entity_id=data.to_entity_id,
        cardinality=data.cardinality, join_type_default=data.join_type_default, is_curated=True,
    )
    relationship_crud.update(db, rel.id, profile=data.profile.model_dump(mode="json"))
    _write_pairs(db, rel.id, data.pairs)
    return get_item(db, rel.id)  # type: ignore[return-value]


def update(db: AttrDatabase, relationship_id: str, data: RelationshipInput) -> RelationshipItem:
    _validate(db, data, relationship_id)
    relationship_crud.update(
        db, relationship_id,
        from_entity_id=data.from_entity_id, to_entity_id=data.to_entity_id,
        cardinality=data.cardinality, join_type_default=data.join_type_default,
        profile=data.profile.model_dump(mode="json"),
    )
    _write_pairs(db, relationship_id, data.pairs)
    return get_item(db, relationship_id)  # type: ignore[return-value]


def soft_delete(db: AttrDatabase, relationship_id: str) -> bool:
    return relationship_crud.delete(db, relationship_id)
