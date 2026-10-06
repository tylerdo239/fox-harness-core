"""Export the hand-entered profile to JSON files and import them into another installation.

Four kinds of file, each exported and imported on its own:

  tables         one data source: its tables and columns (descriptions, synonyms, profile)
  relationships  every relationship between tables
  metrics        every metric
  glossary       every business glossary term

Ids differ between installations, so files never hold ids: a table is named by its data source,
path and name; a column by its name ("config#is_intent_node" for a field inside a JSON column); a
metric by its name; a term by its text. Import turns the names back into this installation's ids.

Tables and columns come from the Dremio import, so an import only fills in matching ones (missing
ones are reported). Relationships, metrics and terms are updated when they match an existing one
(same tables and key columns / same name / same term) and created otherwise. Every item is
validated like a save in the UI; an item that fails is skipped with its problems, the others go
through. dry_run=True checks everything and writes nothing.
"""

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.crud_mongo import relationship as relationship_crud
from src.crud_mongo._shared import set_disabled
from src.data_profile import glossary as glossary_service
from src.data_profile import metrics as metric_service
from src.data_profile import relationships as rel_service
from src.data_profile import service
from src.data_profile.glossary import GlossaryError, GlossaryInput, TermKind
from src.data_profile.metrics import MetricError, MetricInput, MetricKind
from src.data_profile.models import (
    ColumnProfile,
    EntityProfile,
    RelationshipProfile,
    TypedFilter,
)
from src.data_profile.relationships import (
    PairInput,
    RelationshipError,
    RelationshipInput,
)
from src.data_profile.service import JSON_ID_SEP
from src.database.mongodb import AttrDatabase

FORMAT = "data-studio-profile"
VERSION = 1
Kind = Literal["tables", "relationships", "metrics", "glossary"]

_ENTITY_REFS = ("label_column_id", "time_column_id", "snapshot_column_id")   # single column ids in a table profile


class TransferError(ValueError):
    """The file can't be imported at all (wrong kind, not an export)."""


class ImportItem(BaseModel):
    name: str
    action: Literal["create", "update", "skip"]
    problems: list[str] = Field(default_factory=list)


class ImportReport(BaseModel):
    kind: Kind
    dry_run: bool
    items: list[ImportItem] = Field(default_factory=list)
    created: int = 0
    updated: int = 0
    skipped: int = 0
    not_indexed: list[str] = Field(default_factory=list)   # saved, but the search index failed: press "Build index"
    changed_entity_ids: list[str] = Field(default_factory=list, exclude=True)   # for the search index
    changed_metric_ids: list[str] = Field(default_factory=list, exclude=True)
    changed_term_ids: list[str] = Field(default_factory=list, exclude=True)

    def add(self, name: str, action: Literal["create", "update", "skip"], problems: list[str] | None = None) -> None:
        self.items.append(ImportItem(name=name, action=action, problems=problems or []))
        if action == "create":
            self.created += 1
        elif action == "update":
            self.updated += 1
        else:
            self.skipped += 1


def _file(kind: Kind, **body: Any) -> dict[str, Any]:
    return {"format": FORMAT, "version": VERSION, "kind": kind,
            "exported_at": datetime.now(UTC).isoformat(timespec="seconds"), **body}


def check_file(data: Any, kind: Kind) -> dict[str, Any]:
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise TransferError("this is not a profile export file")
    if data.get("kind") != kind:
        raise TransferError(f"this file holds {data.get('kind')}, not {kind}")
    if data.get("version") != VERSION:
        raise TransferError(f"unsupported file version {data.get('version')} (expected {VERSION})")
    return data


# ── names of this installation ──

class Names:
    """Ids ↔ portable names for the active sources, tables and columns of the database."""

    def __init__(self, db: AttrDatabase) -> None:
        self.db = db
        self.sources = {s["_id"]: s for s in data_source_crud.list_active(db)}
        self.tables = {e["_id"]: e for e in entity_crud.list_active(db) if e["data_source_id"] in self.sources}
        self._columns: dict[str, list[dict[str, Any]]] = {}

    def columns(self, entity_id: str) -> list[dict[str, Any]]:
        if entity_id not in self._columns:
            self._columns[entity_id] = service.columns_with_json(service.entity_columns(self.db, entity_id))
        return self._columns[entity_id]

    # export side

    def table_ref(self, entity_id: str | None) -> dict[str, str] | None:
        e = self.tables.get(entity_id or "")
        if e is None:
            return None
        return {"source": self.sources[e["data_source_id"]]["name"], "path": e["physical_path"], "name": e["physical_name"]}

    def column_name(self, entity_id: str, column_id: str | None) -> str | None:
        if not column_id:
            return None
        base, _, path = column_id.partition(JSON_ID_SEP)
        for c in self.columns(entity_id):
            if c["_id"] == base:
                return f"{c['physical_name']}{JSON_ID_SEP}{path}" if path else c["physical_name"]
        return None

    # import side

    def find_table(self, ref: Any, source_id: str | None = None) -> str | None:
        """A table by (source, path), else by path, else by its name when only one table has it."""
        if not isinstance(ref, dict):
            return None
        pool = [e for e in self.tables.values() if source_id is None or e["data_source_id"] == source_id]
        if source_id is None and ref.get("source"):
            same = [e for e in pool if self.sources[e["data_source_id"]]["name"] == ref["source"]
                    and e["physical_path"] == ref.get("path")]
            if same:
                return same[0]["_id"]
        for key, field in (("path", "physical_path"), ("name", "physical_name")):
            hits = [e for e in pool if ref.get(key) and e[field] == ref[key]]
            if len(hits) == 1:
                return hits[0]["_id"]
        return None

    def find_column(self, entity_id: str, name: Any) -> str | None:
        if not isinstance(name, str) or not name:
            return None
        base, _, path = name.partition(JSON_ID_SEP)
        for c in self.columns(entity_id):
            if c["physical_name"] == base and not c.get("json_path"):
                return f"{c['_id']}{JSON_ID_SEP}{path}" if path else c["_id"]
        return None


def _ref_text(ref: Any) -> str:
    return f"{ref.get('source', '?')}.{ref.get('name') or ref.get('path')}" if isinstance(ref, dict) else str(ref)


def _filters_out(h: Names, entity_id: str, filters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"column": h.column_name(entity_id, f.get("column_id")) or "?",
             **{k: v for k, v in f.items() if k != "column_id"}} for f in filters]


def _filters_in(h: Names, entity_id: str, filters: Any, where: str, problems: list[str]) -> list[TypedFilter]:
    out = []
    for i, f in enumerate(filters or [], 1):
        cid = h.find_column(entity_id, f.get("column"))
        if cid is None:
            problems.append(f"{where} {i}: column {f.get('column')!r} not found")
            continue
        try:
            out.append(TypedFilter.model_validate({**{k: v for k, v in f.items() if k != "column"}, "column_id": cid}))
        except ValidationError as err:
            problems.append(f"{where} {i}: {err.errors()[0]['msg']}")
    return out


def _problems_of(err: ValidationError) -> list[str]:
    return [f"{'.'.join(str(x) for x in e['loc'])}: {e['msg']}" for e in err.errors()]


# ── tables and columns of one data source ──

def export_tables(db: AttrDatabase, source: dict[str, Any]) -> dict[str, Any]:
    h = Names(db)
    tables = []
    for e in sorted((e for e in h.tables.values() if e["data_source_id"] == source["_id"]), key=lambda e: e["physical_path"]):
        eid = e["_id"]
        profile = service.entity_profile(e).model_dump(mode="json")
        profile["grain_key_columns"] = [h.column_name(eid, c) for c in profile.pop("grain_key_column_ids")]
        for key in _ENTITY_REFS:
            profile[key.removesuffix("_id")] = h.column_name(eid, profile.pop(key))
        for key in ("default_filters", "list_filters"):
            profile[key] = _filters_out(h, eid, profile[key])
        columns = []
        for c in service.entity_columns(db, eid):
            cp = service.column_profile(c).model_dump(mode="json")
            cp["parent_column"] = h.column_name(eid, cp.pop("parent_column_id"))
            columns.append({"name": c["physical_name"], "data_type": c.get("data_type"),
                            **{k: c.get(k) for k in service.COLUMN_BASIC_FIELDS}, "profile": cp})
        tables.append({"path": e["physical_path"], "name": e["physical_name"],
                       **{k: e.get(k) for k in service.ENTITY_BASIC_FIELDS}, "profile": profile, "columns": columns})
    return _file("tables", source={"name": source["name"], "source_type": source.get("source_type")}, tables=tables)


def import_tables(db: AttrDatabase, source: dict[str, Any], data: Any, dry_run: bool) -> ImportReport:
    data = check_file(data, "tables")
    h = Names(db)
    report = ImportReport(kind="tables", dry_run=dry_run)
    for t in data.get("tables") or []:
        name = str(t.get("path") or t.get("name"))
        eid = h.find_table(t, source["_id"])
        if eid is None:
            report.add(name, "skip", ["no such table in this data source (import it from Dremio first)"])
            continue
        entity, problems = h.tables[eid], []
        stored = {c["physical_name"]: c for c in service.entity_columns(db, eid)}
        columns: list[tuple[dict[str, Any], dict[str, Any], ColumnProfile]] = []
        missing = []
        for c in t.get("columns") or []:
            col = stored.get(c.get("name"))
            if col is None:
                missing.append(str(c.get("name")))
                continue
            cp = dict(c.get("profile") or {})
            parent = cp.pop("parent_column", None)
            cp["parent_column_id"] = h.find_column(eid, parent) if parent else None
            if parent and cp["parent_column_id"] is None:
                problems.append(f"{col['physical_name']}: parent column {parent!r} not found")
            try:
                profile = ColumnProfile.model_validate(cp)
            except ValidationError as err:
                problems += [f"{col['physical_name']}: {p}" for p in _problems_of(err)]
                continue
            problems += [f"{col['physical_name']}: {p}" for p in
                         service.validate_column_profile(profile, col, list(stored.values()))]
            columns.append((col, {k: c.get(k) for k in service.COLUMN_BASIC_FIELDS if k in c}, profile))

        # the table profile refers to JSON fields declared on the columns: resolve against the new ones
        updated = {col["_id"]: {**col, "profile": p.model_dump(mode="json")} for col, _, p in columns}
        after = [updated.get(c["_id"], c) for c in stored.values()]   # the columns as they will be saved
        h._columns[eid] = service.columns_with_json(after)
        ep = dict(t.get("profile") or {})
        ep["grain_key_column_ids"] = [h.find_column(eid, n) for n in ep.pop("grain_key_columns", None) or []]
        if None in ep["grain_key_column_ids"]:
            problems.append("grain key: a column was not found")
            ep["grain_key_column_ids"] = [c for c in ep["grain_key_column_ids"] if c]
        for key in _ENTITY_REFS:
            n = ep.pop(key.removesuffix("_id"), None)
            ep[key] = h.find_column(eid, n) if n else None
            if n and ep[key] is None:
                problems.append(f"{key.removesuffix('_id').replace('_', ' ')}: column {n!r} not found")
        for key in ("default_filters", "list_filters"):
            ep[key] = _filters_in(h, eid, ep.get(key), key.replace("_", " ").removesuffix("s"), problems)
        try:
            entity_profile = EntityProfile.model_validate(ep)
            problems += service.validate_entity_profile(entity_profile, after)
        except ValidationError as err:
            problems += _problems_of(err)
        if problems:
            report.add(name, "skip", problems)
            continue
        if not dry_run:
            for col, basics, profile in columns:
                service.save_column(db, col, basics, profile)
            service.save_entity(db, entity, {k: t.get(k) for k in service.ENTITY_BASIC_FIELDS if k in t},
                                entity_profile)
            report.changed_entity_ids.append(eid)
        report.add(name, "update", [f"{len(missing)} column(s) not in this table: {', '.join(missing)}"] if missing else [])
    return report


# ── relationships ──

def export_relationships(db: AttrDatabase) -> dict[str, Any]:
    h = Names(db)
    items = []
    for r in relationship_crud.list_all(db):
        if r.get("deleted_at") or r["from_entity_id"] not in h.tables or r["to_entity_id"] not in h.tables:
            continue
        pairs = sorted(relationship_crud.list_column_pairs(db, r["_id"]), key=lambda p: p.get("seq", 0))
        items.append({
            "from_table": h.table_ref(r["from_entity_id"]), "to_table": h.table_ref(r["to_entity_id"]),
            "pairs": [{"from_column": h.column_name(r["from_entity_id"], p["from_column_id"]),
                       "to_column": h.column_name(r["to_entity_id"], p["to_column_id"])} for p in pairs],
            "cardinality": r.get("cardinality"), "join_type_default": r.get("join_type_default"),
            "profile": service.relationship_profile(r).model_dump(mode="json"),
        })
    return _file("relationships", relationships=items)


def _same_relationship(db: AttrDatabase, data: RelationshipInput) -> str | None:
    wanted = {(p.from_column_id, p.to_column_id) for p in data.pairs}
    reverse = {(b, a) for a, b in wanted}
    for other in relationship_crud.list_touching_entity_ids(db, [data.from_entity_id]):
        if {other["from_entity_id"], other["to_entity_id"]} != {data.from_entity_id, data.to_entity_id}:
            continue
        have = {(p["from_column_id"], p["to_column_id"]) for p in relationship_crud.list_column_pairs(db, other["_id"])}
        if have in (wanted, reverse):
            return other["_id"]
    return None


def import_relationships(db: AttrDatabase, data: Any, dry_run: bool) -> ImportReport:
    data = check_file(data, "relationships")
    h = Names(db)
    report = ImportReport(kind="relationships", dry_run=dry_run)
    for r in data.get("relationships") or []:
        name = f"{_ref_text(r.get('from_table'))} → {_ref_text(r.get('to_table'))}"
        problems: list[str] = []
        ids = {side: h.find_table(r.get(f"{side}_table")) for side in ("from", "to")}
        for side, eid in ids.items():
            if eid is None:
                problems.append(f"{side} table {_ref_text(r.get(f'{side}_table'))} not found")
        if problems:
            report.add(name, "skip", problems)
            continue
        pairs = []
        for i, p in enumerate(r.get("pairs") or [], 1):
            a, b = h.find_column(ids["from"], p.get("from_column")), h.find_column(ids["to"], p.get("to_column"))
            if a is None or b is None:
                problems.append(f"pair {i}: column {p.get('from_column') if a is None else p.get('to_column')!r} not found")
            else:
                pairs.append(PairInput(from_column_id=a, to_column_id=b))
        try:
            rel = RelationshipInput(from_entity_id=ids["from"], to_entity_id=ids["to"], pairs=pairs,
                                    cardinality=r.get("cardinality"), join_type_default=r.get("join_type_default"),
                                    profile=RelationshipProfile.model_validate(r.get("profile") or {}))
        except ValidationError as err:
            report.add(name, "skip", problems + _problems_of(err))
            continue
        if problems:
            report.add(name, "skip", problems)
            continue
        existing = _same_relationship(db, rel)
        try:
            if dry_run:
                rel_service._validate(db, rel, existing)
            elif existing:
                rel_service.update(db, existing, rel)
            else:
                rel_service.create(db, rel)
        except RelationshipError as err:
            report.add(name, "skip", err.errors)
            continue
        report.add(name, "update" if existing else "create")
    return report


# ── metrics ──

def export_metrics(db: AttrDatabase) -> dict[str, Any]:
    h = Names(db)
    docs = metric_service._all(db)
    names = {m["_id"]: m["name"] for m in docs}
    items = []
    for m in docs:
        eid = m.get("entity_id")
        item = MetricInput.model_validate(m).model_dump(mode="json")
        for key in ("entity_id", "column_id", "time_column_id", "numerator_metric_id", "denominator_metric_id", "filters"):
            item.pop(key)
        item.update({
            "table": h.table_ref(eid),
            "column": h.column_name(eid, m.get("column_id")) if eid else None,
            "time_column": h.column_name(eid, m.get("time_column_id")) if eid else None,
            "filters": _filters_out(h, eid, m.get("filters") or []) if eid else [],
            "numerator_metric": names.get(m.get("numerator_metric_id") or ""),
            "denominator_metric": names.get(m.get("denominator_metric_id") or ""),
            "disabled": bool(m.get("disabled_at")),
        })
        items.append(item)
    return _file("metrics", metrics=items)


def import_metrics(db: AttrDatabase, data: Any, dry_run: bool) -> ImportReport:
    data = check_file(data, "metrics")
    h = Names(db)
    report = ImportReport(kind="metrics", dry_run=dry_run)
    items = list(data.get("metrics") or [])
    items.sort(key=lambda m: m.get("kind") == MetricKind.RATIO)   # ratios after the metrics they divide
    planned = {str(m.get("name")) for m in items}                  # names this file creates (for a dry run)
    for m in items:
        name, problems = str(m.get("name") or "?"), []
        by_name = {d["name"]: d["_id"] for d in metric_service._all(db)}
        body = {k: v for k, v in m.items() if k not in ("table", "column", "time_column", "filters", "numerator_metric",
                                                        "denominator_metric", "disabled")}
        if m.get("kind") == MetricKind.RATIO:
            for side in ("numerator", "denominator"):
                ref = m.get(f"{side}_metric")
                body[f"{side}_metric_id"] = by_name.get(ref) or (f"planned:{ref}" if dry_run and ref in planned else None)
                if body[f"{side}_metric_id"] is None:
                    problems.append(f"{side}: metric {ref!r} not found")
        else:
            eid = h.find_table(m.get("table"))
            if eid is None:
                problems.append(f"table {_ref_text(m.get('table'))} not found")
            else:
                body["entity_id"] = eid
                for key in ("column", "time_column"):
                    if m.get(key):
                        body[f"{key}_id"] = h.find_column(eid, m[key])
                        if body[f"{key}_id"] is None:
                            problems.append(f"{key.replace('_', ' ')} {m[key]!r} not found")
                body["filters"] = _filters_in(h, eid, m.get("filters"), "filter", problems)
        if problems:
            report.add(name, "skip", problems)
            continue
        existing = by_name.get(name)
        try:
            metric = MetricInput.model_validate(body)
            if dry_run:
                if not (metric.kind == MetricKind.RATIO and any(
                        str(x).startswith("planned:") for x in (metric.numerator_metric_id, metric.denominator_metric_id))):
                    metric_service._validate(db, metric, existing)
            else:
                doc = metric_service.update(db, existing, metric) if existing else metric_service.create(db, metric)
                set_disabled(db, metric_service.COLLECTION, doc["_id"], bool(m.get("disabled")))
                report.changed_metric_ids.append(doc["_id"])
        except ValidationError as err:
            report.add(name, "skip", _problems_of(err))
            continue
        except MetricError as err:
            report.add(name, "skip", err.errors)
            continue
        report.add(name, "update" if existing else "create")
    return report


# ── business glossary ──

def export_glossary(db: AttrDatabase) -> dict[str, Any]:
    h = Names(db)
    metric_names = {m["_id"]: m["name"] for m in metric_service._all(db)}
    items = []
    for g in glossary_service._all(db):
        eid = g.get("entity_id")
        item = GlossaryInput.model_validate(g).model_dump(mode="json")
        for key in ("entity_id", "filters", "metric_id", "related_entity_ids"):
            item.pop(key)
        item.update({
            "table": h.table_ref(eid),
            "filters": _filters_out(h, eid, g.get("filters") or []) if eid else [],
            "metric": metric_names.get(g.get("metric_id") or ""),
            "related_tables": [r for r in (h.table_ref(x) for x in g.get("related_entity_ids") or []) if r],
            "disabled": bool(g.get("disabled_at")),
        })
        items.append(item)
    return _file("glossary", glossary=items)


def import_glossary(db: AttrDatabase, data: Any, dry_run: bool) -> ImportReport:
    data = check_file(data, "glossary")
    h = Names(db)
    report = ImportReport(kind="glossary", dry_run=dry_run)
    metrics = {m["name"]: m["_id"] for m in metric_service._all(db)}
    for g in data.get("glossary") or []:
        name, problems = str(g.get("term") or "?"), []
        body = {k: v for k, v in g.items() if k not in ("table", "filters", "metric", "related_tables", "disabled")}
        kind = g.get("kind")
        if kind == TermKind.SEGMENT:
            eid = h.find_table(g.get("table"))
            if eid is None:
                problems.append(f"table {_ref_text(g.get('table'))} not found")
            else:
                body["entity_id"] = eid
                body["filters"] = _filters_in(h, eid, g.get("filters"), "filter", problems)
        elif kind == TermKind.METRIC:
            body["metric_id"] = metrics.get(g.get("metric"))
            if body["metric_id"] is None:
                problems.append(f"metric {g.get('metric')!r} not found (import the metrics first)")
        else:
            body["related_entity_ids"] = []
            for ref in g.get("related_tables") or []:
                if (eid := h.find_table(ref)) is None:
                    problems.append(f"related table {_ref_text(ref)} not found")
                else:
                    body["related_entity_ids"].append(eid)
        if problems:
            report.add(name, "skip", problems)
            continue
        existing = next((d["_id"] for d in glossary_service._all(db) if d["term"].lower() == name.lower()), None)
        try:
            term = GlossaryInput.model_validate(body)
            if dry_run:
                glossary_service._validate(db, term, existing)
            else:
                doc = glossary_service.update(db, existing, term) if existing else glossary_service.create(db, term)
                set_disabled(db, glossary_service.COLLECTION, doc["_id"], bool(g.get("disabled")))
                report.changed_term_ids.append(doc["_id"])
        except ValidationError as err:
            report.add(name, "skip", _problems_of(err))
            continue
        except GlossaryError as err:
            report.add(name, "skip", err.errors)
            continue
        report.add(name, "update" if existing else "create")
    return report
