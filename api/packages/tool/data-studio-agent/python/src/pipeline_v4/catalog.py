"""Everything the compiler needs from the profile, loaded once per question into memory.

The compiler never reads MongoDB itself, so it can be tested with a hand-built Catalog.
"""

from dataclasses import dataclass, field
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

from src.data_profile import service
from src.data_profile.glossary import COLLECTION as GLOSSARY_COLLECTION
from src.data_profile.metrics import COLLECTION as METRICS_COLLECTION
from src.data_profile.models import ColumnProfile, EntityProfile, RelationshipProfile


@dataclass
class Table:
    id: str
    physical_path: str
    physical_name: str
    display_name: str
    data_source_id: str
    profile: EntityProfile
    is_exposed: bool = True
    is_pii: bool = False
    description: str | None = None
    synonyms: list[str] = field(default_factory=list)
    grain_description: str | None = None   # "one row is …"


@dataclass
class Column:
    id: str
    entity_id: str
    physical_name: str          # "config.is_intent_node" for a JSON field
    display_name: str
    data_type: str
    role: str | None
    semantic_type: str | None
    profile: ColumnProfile
    is_exposed: bool = True
    is_pii: bool = False
    json_source: str | None = None  # the real column holding the JSON
    json_path: str | None = None
    description: str | None = None
    synonyms: list[str] = field(default_factory=list)


@dataclass
class Join:
    id: str
    from_entity_id: str
    to_entity_id: str
    cardinality: str            # "1:1" | "1:N" | "N:N" (from → to)
    join_type_default: str      # "left" | "inner"
    pairs: list[tuple[str, str]]  # (from column id, to column id)
    profile: RelationshipProfile


@dataclass
class Catalog:
    tables: dict[str, Table] = field(default_factory=dict)
    columns: dict[str, Column] = field(default_factory=dict)
    joins: list[Join] = field(default_factory=list)
    metrics: dict[str, dict[str, Any]] = field(default_factory=dict)
    glossary: dict[str, dict[str, Any]] = field(default_factory=dict)

    def columns_of(self, entity_id: str) -> list[Column]:
        return [c for c in self.columns.values() if c.entity_id == entity_id]


def _column(doc: dict[str, Any]) -> Column:
    return Column(
        id=doc["_id"],
        entity_id=doc["entity_id"],
        physical_name=doc["physical_name"],
        display_name=doc.get("display_name") or doc["physical_name"],
        data_type=str(doc.get("data_type") or "UNKNOWN").upper(),
        role=doc.get("role"),
        semantic_type=doc.get("semantic_type"),
        profile=service.column_profile(doc),
        is_exposed=bool(doc.get("is_exposed")),
        is_pii=bool(doc.get("is_pii")),
        json_source=doc.get("json_source"),
        json_path=doc.get("json_path"),
        description=doc.get("description"),
        synonyms=list(doc.get("synonyms") or []),
    )


async def load_catalog(db: AsyncDatabase) -> Catalog:
    """All active tables of active sources, their columns (with JSON fields), relationships,
    metrics and glossary terms. Sources, metrics and terms turned off in the profile (disabled_at) are
    left out, and with them what is built on them (a source's tables; a ratio of a disabled metric;
    a term on a disabled metric): the agents can't find or use them."""
    active = {"deleted_at": None}
    enabled = {"deleted_at": None, "disabled_at": None}
    sources = {s["_id"] for s in await db["data_sources"].find(enabled, {"_id": 1}).to_list()}
    cat = Catalog()
    for e in await db["entities"].find({"is_deprecated": False}).to_list():
        if e["data_source_id"] not in sources:
            continue
        cat.tables[e["_id"]] = Table(
            id=e["_id"],
            physical_path=e["physical_path"],
            physical_name=e["physical_name"],
            display_name=e.get("display_name") or e["physical_name"],
            data_source_id=e["data_source_id"],
            profile=service.entity_profile(e),
            is_exposed=bool(e.get("is_exposed")),
            is_pii=bool(e.get("is_pii")),
            description=e.get("description"),
            synonyms=list(e.get("synonyms") or []),
            grain_description=e.get("grain_description"),
        )
    raw = await db["entity_columns"].find({"entity_id": {"$in": list(cat.tables)}, "is_deprecated": False}).to_list()
    for doc in service.columns_with_json(raw):
        cat.columns[doc["_id"]] = _column(doc)

    rels = [r for r in await db["relationships"].find(active).to_list()
            if r["from_entity_id"] in cat.tables and r["to_entity_id"] in cat.tables]
    pairs = await db["relationship_column_pairs"].find(
        {"relationship_id": {"$in": [r["_id"] for r in rels]}, "deleted_at": None}
    ).to_list()
    for r in rels:
        rp = sorted((p for p in pairs if p["relationship_id"] == r["_id"]), key=lambda p: p.get("seq", 0))
        cat.joins.append(Join(
            id=r["_id"], from_entity_id=r["from_entity_id"], to_entity_id=r["to_entity_id"],
            cardinality=r.get("cardinality") or "1:N", join_type_default=r.get("join_type_default") or "left",
            pairs=[(p["from_column_id"], p["to_column_id"]) for p in rp],
            profile=service.relationship_profile(r),
        ))
    cat.metrics = {m["_id"]: m for m in await db[METRICS_COLLECTION].find(enabled).to_list()}
    cat.metrics = {k: m for k, m in cat.metrics.items() if m.get("kind") != "ratio" or all(
        m.get(side) in cat.metrics for side in ("numerator_metric_id", "denominator_metric_id"))}
    cat.glossary = {g["_id"]: g for g in await db[GLOSSARY_COLLECTION].find(enabled).to_list()
                    if not g.get("metric_id") or g["metric_id"] in cat.metrics}
    add_row_counts(cat)
    return cat


BUILTIN_PREFIX = "builtin:count:"


def row_count_id(table_id: str) -> str:
    return f"{BUILTIN_PREFIX}{table_id}"


def add_row_counts(cat: Catalog) -> None:
    """A built-in metric per exposed table, `count_<table>` = number of rows (with the table's
    always-applied filters), so "how many X" works without saving a count metric for every table.
    A saved metric with the same name wins."""
    taken = {m.get("name") for m in cat.metrics.values()}
    for t in sorted(cat.tables.values(), key=lambda t: t.physical_path):
        if not t.is_exposed or t.is_pii:
            continue
        name = f"count_{t.physical_name}".lower()
        if name in taken:
            name = f"count_{t.physical_path.replace('.', '_')}".lower()
        if name in taken:
            continue
        taken.add(name)
        one_row = f" (one row = {t.grain_description})" if t.grain_description else ""
        cat.metrics[row_count_id(t.id)] = {
            "_id": row_count_id(t.id), "name": name, "display_name": f"Row count of {t.display_name}",
            "description": f"Number of rows of {t.physical_name}{one_row}.", "kind": "aggregate",
            "entity_id": t.id, "aggregation": "count", "column_id": None, "filters": [],
            "use_table_default_filters": True, "builtin": True,
        }
