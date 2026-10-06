"""Read, validate and save the human-entered profile of a table, its columns and relationships."""

from typing import Any

from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.crud_mongo import relationship as relationship_crud
from src.crud_mongo._shared import utcnow
from src.data_profile.checklist import Checklist, build_checklist
from src.data_profile.models import (
    MULTI_VALUE_OPS,
    NO_VALUE_OPS,
    ColumnProfile,
    EntityProfile,
    ProfileReview,
    RelationshipProfile,
    TypedFilter,
)
from src.database.mongodb import AttrDatabase, AttrDict


class ProfileError(ValueError):
    """A profile that can't be saved; the message is shown to the person editing it."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


# ── reading ──

def entity_profile(entity: dict[str, Any]) -> EntityProfile:
    return EntityProfile.model_validate(entity.get("profile") or {})


def column_profile(column: dict[str, Any]) -> ColumnProfile:
    return ColumnProfile.model_validate(column.get("profile") or {})


def relationship_profile(rel: dict[str, Any]) -> RelationshipProfile:
    return RelationshipProfile.model_validate(rel.get("profile") or {})


def review_of(entity: dict[str, Any]) -> ProfileReview:
    return ProfileReview.model_validate(entity.get("profile_review") or {})


def entity_columns(db: AttrDatabase, entity_id: str) -> list[AttrDict]:
    return entity_column_crud.list_by_entity(db, entity_id)


def entity_relationships(db: AttrDatabase, entity_id: str) -> list[dict[str, Any]]:
    """Relationships touching the entity, with their column pairs and the other table's name."""
    rels = relationship_crud.list_touching_entity_ids(db, [entity_id])
    if not rels:
        return []
    other_ids = {r["to_entity_id"] if r["from_entity_id"] == entity_id else r["from_entity_id"] for r in rels}
    others = {e["_id"]: e for e in entity_crud.list_by_ids(db, list(other_ids | {entity_id}))}
    pairs = relationship_crud.list_column_pairs_by_relationship_ids(db, [r["_id"] for r in rels])
    col_ids = {p["from_column_id"] for p in pairs} | {p["to_column_id"] for p in pairs}
    col_names = {c["_id"]: c["physical_name"] for c in entity_column_crud.list_by_ids(db, list(col_ids))}

    result = []
    for rel in rels:
        is_from = rel["from_entity_id"] == entity_id
        other_id = rel["to_entity_id"] if is_from else rel["from_entity_id"]
        other = others.get(other_id)
        rel_pairs = sorted((p for p in pairs if p["relationship_id"] == rel["_id"]), key=lambda p: p.get("seq", 0))
        result.append(
            {
                "id": rel["_id"],
                "direction": "from" if is_from else "to",
                "from_entity_name": _entity_name(others.get(rel["from_entity_id"])),
                "to_entity_name": _entity_name(others.get(rel["to_entity_id"])),
                "other_entity_id": other_id,
                "other_entity_name": _entity_name(other),
                "cardinality": rel.get("cardinality"),
                "join_type_default": rel.get("join_type_default"),
                "pairs": [
                    {
                        "from_column": col_names.get(p["from_column_id"], "?"),
                        "to_column": col_names.get(p["to_column_id"], "?"),
                    }
                    for p in rel_pairs
                ],
                "profile": relationship_profile(rel),
            }
        )
    return result


def _entity_name(entity: dict[str, Any] | None) -> str:
    if entity is None:
        return "?"
    return entity.get("display_name") or entity.get("physical_name") or "?"


def checklist_for(db: AttrDatabase, entity: dict[str, Any]) -> Checklist:
    columns = entity_columns(db, entity["_id"])
    rel_count = len(relationship_crud.list_touching_entity_ids(db, [entity["_id"]]))
    return build_checklist(
        entity, entity_profile(entity), [(c, column_profile(c)) for c in columns], rel_count
    )


# ── JSON fields: each declared field behaves like an extra column with id "<column id>#<path>" ──

JSON_ID_SEP = "#"
_TEXT_TYPES = {"VARCHAR", "CHAR", "STRING", "CHARACTER VARYING"}
_JSON_SEMANTIC = {"BOOLEAN": "boolean", "DATE": "date", "TIMESTAMP": "datetime", "VARCHAR": "text"}


def json_columns(columns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for c in columns:
        for f in column_profile(c).json_fields:
            result.append({
                "_id": f"{c['_id']}{JSON_ID_SEP}{f.path}",
                "entity_id": c.get("entity_id"),
                "physical_name": f"{c['physical_name']}.{f.path}",
                "display_name": f.display_name or f"{c['physical_name']}.{f.path}",
                "description": f.description,
                "synonyms": [],
                "data_type": f.data_type.value,
                "role": "dimension",
                "semantic_type": _JSON_SEMANTIC.get(f.data_type.value, "category" if f.value_catalog else "number"),
                "is_exposed": c.get("is_exposed"),
                "is_pii": c.get("is_pii"),
                "is_deprecated": c.get("is_deprecated"),
                "profile": {"value_catalog": [v.model_dump() for v in f.value_catalog],
                            "value_catalog_complete": f.value_catalog_complete},
                "json_source": c["physical_name"],
                "json_path": f.path,
                "json_parent_id": c["_id"],
            })
    return result


def columns_with_json(columns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [*columns, *json_columns(columns)]


# ── validation ──

def _filter_errors(f: TypedFilter, columns_by_id: dict[str, dict[str, Any]], where: str) -> list[str]:
    col = columns_by_id.get(f.column_id)
    if col is None:
        return [f"{where}: column does not belong to this table"]
    name = col["physical_name"]
    errors = []
    if f.op in NO_VALUE_OPS and f.values:
        errors.append(f"{where} on {name}: '{f.op}' takes no value")
    elif f.op in MULTI_VALUE_OPS and not f.values:
        errors.append(f"{where} on {name}: '{f.op}' needs at least one value")
    elif f.op not in NO_VALUE_OPS and f.op not in MULTI_VALUE_OPS and len(f.values) != 1:
        errors.append(f"{where} on {name}: '{f.op}' needs exactly one value")

    cp = column_profile(col)
    if cp.value_catalog_complete and cp.value_catalog and f.op not in NO_VALUE_OPS:
        known = {item.value for item in cp.value_catalog}
        unknown = [str(v) for v in f.values if str(v) not in known]
        if unknown:
            errors.append(
                f"{where} on {name}: {', '.join(unknown)} not in the column's value list "
                f"({', '.join(sorted(known))})"
            )
    return errors


def validate_entity_profile(profile: EntityProfile, columns: list[dict[str, Any]]) -> list[str]:
    columns_by_id = {c["_id"]: c for c in columns_with_json(columns)}
    errors = []
    refs = {
        "grain key": profile.grain_key_column_ids,
        "time column": [profile.time_column_id] if profile.time_column_id else [],
        "snapshot column": [profile.snapshot_column_id] if profile.snapshot_column_id else [],
        "label column": [profile.label_column_id] if profile.label_column_id else [],
    }
    for label, ids in refs.items():
        for cid in ids:
            if cid not in columns_by_id:
                errors.append(f"{label}: column does not belong to this table")
    if len(set(profile.grain_key_column_ids)) != len(profile.grain_key_column_ids):
        errors.append("grain key: the same column is picked twice")
    for i, f in enumerate(profile.default_filters, start=1):
        errors += _filter_errors(f, columns_by_id, f"default filter {i}")
    for i, f in enumerate(profile.list_filters, start=1):
        errors += _filter_errors(f, columns_by_id, f"list filter {i}")
    if profile.coverage_start and profile.coverage_end and profile.coverage_start > profile.coverage_end:
        errors.append("coverage: start date is after end date")
    return errors


def validate_column_profile(
    profile: ColumnProfile, column: dict[str, Any], columns: list[dict[str, Any]]
) -> list[str]:
    errors = []
    if profile.json_fields and str(column.get("data_type", "")).upper() not in _TEXT_TYPES:
        errors.append(f"JSON fields need a text column; {column['physical_name']} is {column.get('data_type')}")
    if profile.parent_column_id is not None:
        if profile.parent_column_id == column["_id"]:
            errors.append("parent column: a column cannot be its own parent")
        elif profile.parent_column_id not in {c["_id"] for c in columns}:
            errors.append("parent column: column does not belong to this table")
        else:
            parents = {c["_id"]: column_profile(c).parent_column_id for c in columns}
            parents[column["_id"]] = profile.parent_column_id
            seen, current = {column["_id"]}, profile.parent_column_id
            while current is not None:
                if current in seen:
                    errors.append("parent column: this would make a loop of parents")
                    break
                seen.add(current)
                current = parents.get(current)
    if profile.normal_min is not None and profile.normal_max is not None and profile.normal_min > profile.normal_max:
        errors.append("normal range: min is greater than max")
    return errors


# ── writing ──

ENTITY_BASIC_FIELDS = ("display_name", "description", "synonyms", "grain_description", "is_exposed", "is_pii")
COLUMN_BASIC_FIELDS = (
    "display_name", "description", "synonyms", "role", "semantic_type",
    "default_aggregation", "is_exposed", "is_pii",
)


def save_entity(db: AttrDatabase, entity: AttrDict, basics: dict[str, Any], profile: EntityProfile) -> AttrDict:
    errors = validate_entity_profile(profile, entity_columns(db, entity.id))
    if errors:
        raise ProfileError(errors)
    fields = {k: v for k, v in basics.items() if k in ENTITY_BASIC_FIELDS}
    return entity_crud.update(db, entity.id, **fields, profile=profile.model_dump(mode="json"))


def save_column(db: AttrDatabase, column: AttrDict, basics: dict[str, Any], profile: ColumnProfile) -> AttrDict:
    errors = validate_column_profile(profile, column, entity_columns(db, column.entity_id))
    if errors:
        raise ProfileError(errors)
    fields = {k: v for k, v in basics.items() if k in COLUMN_BASIC_FIELDS}
    if fields.get("role") is not None and fields["role"] != "measure":
        fields["default_aggregation"] = None
    return entity_column_crud.update(db, column.id, **fields, profile=profile.model_dump(mode="json"))


def save_relationship_profile(db: AttrDatabase, rel: AttrDict, profile: RelationshipProfile) -> AttrDict:
    return relationship_crud.update(db, rel.id, profile=profile.model_dump(mode="json"))


def mark_reviewed(db: AttrDatabase, entity: AttrDict, username: str) -> AttrDict:
    checklist = checklist_for(db, entity)
    missing = [i for i in checklist.missing if i.level == "required"]
    if missing:
        raise ProfileError(
            [f"{len(missing)} required item(s) still missing, e.g. {missing[0].target_name}: {missing[0].message}"]
        )
    review = ProfileReview(reviewed_by=username, reviewed_at=utcnow(), needs_review=False)
    return entity_crud.update(db, entity.id, profile_review=review.model_dump(mode="json"))


def flag_needs_review(db: AttrDatabase, entity_id: str, reasons: list[str]) -> None:
    """Called by the Dremio sync when a table's columns change; curated values are left as they are."""
    entity = entity_crud.get_by_id(db, entity_id)
    if entity is None or not reasons:
        return
    review = review_of(entity)
    review.needs_review = True
    review.needs_review_reasons = list(dict.fromkeys([*review.needs_review_reasons, *reasons]))
    entity_crud.update(db, entity_id, profile_review=review.model_dump(mode="json"))
