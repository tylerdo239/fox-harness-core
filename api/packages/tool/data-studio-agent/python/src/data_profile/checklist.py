"""What is still missing in a table's profile.

"required" items block marking a table as reviewed; "recommended" items improve answers but have a
safe fallback. Only exposed, non-deprecated columns are checked.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from src.data_profile.models import ColumnProfile, EntityProfile, TableKind

Level = Literal["required", "recommended"]
Scope = Literal["table", "column", "relationship"]

# Dremio type names whose values carry a time of day, so the storage time zone matters
_TIMESTAMP_TYPES = {"TIMESTAMP", "TIMESTAMPTZ", "DATETIME"}
# real date/time types; a date stored in any other type needs its format written down
_DATE_TYPES = {"DATE", "TIME", *_TIMESTAMP_TYPES}


class ChecklistItem(BaseModel):
    level: Level
    scope: Scope
    target_id: str
    target_name: str
    field: str
    message: str


class Checklist(BaseModel):
    required_done: int = 0
    required_total: int = 0
    recommended_done: int = 0
    recommended_total: int = 0
    missing: list[ChecklistItem] = Field(default_factory=list)


class _Builder:
    def __init__(self) -> None:
        self.result = Checklist()

    def check(
        self, ok: bool, level: Level, scope: Scope, target_id: str, target_name: str, field: str, message: str
    ) -> None:
        if level == "required":
            self.result.required_total += 1
            self.result.required_done += ok
        else:
            self.result.recommended_total += 1
            self.result.recommended_done += ok
        if not ok:
            self.result.missing.append(
                ChecklistItem(
                    level=level, scope=scope, target_id=target_id,
                    target_name=target_name, field=field, message=message,
                )
            )


def build_checklist(
    entity: dict[str, Any],
    profile: EntityProfile,
    columns: list[tuple[dict[str, Any], ColumnProfile]],
    relationship_count: int,
) -> Checklist:
    b = _Builder()
    eid, ename = entity["_id"], entity.get("display_name") or entity["physical_name"]
    cols_by_id = {c["_id"]: c for c, _ in columns}

    def table(ok: bool, level: Level, field: str, message: str) -> None:
        b.check(ok, level, "table", eid, ename, field, message)

    table(bool(entity.get("description")), "required", "description", "Describe what this table contains")
    table(bool(entity.get("grain_description")), "required", "grain_description", "Say what one row is (\"1 row = 1 order\")")
    table(profile.table_kind is not None, "required", "table_kind", "Choose the table kind")
    table(bool(profile.grain_key_column_ids), "required", "grain_key_column_ids", "Pick the columns that identify one row")
    table(profile.trust is not None, "required", "trust", "Mark the table as certified or raw")
    if profile.table_kind in (TableKind.DIM, TableKind.SCD2):
        table(profile.label_column_id is not None, "required", "label_column_id",
              "Pick the column that names a row (shown instead of the id)")

    if profile.table_kind in (TableKind.FACT, TableKind.SNAPSHOT):
        table(profile.time_column_id is not None, "required", "time_column_id", "Pick the main date/time column")
    if profile.table_kind == TableKind.SNAPSHOT:
        table(profile.snapshot_column_id is not None, "required", "snapshot_column_id", "Pick the snapshot date column")
    if profile.time_column_id:
        table(bool(profile.business_tz), "required", "business_tz", "Set the business time zone")
        time_col = cols_by_id.get(profile.time_column_id)
        if time_col is not None and str(time_col.get("data_type", "")).upper() in _TIMESTAMP_TYPES:
            table(bool(profile.storage_tz), "required", "storage_tz", "Set the time zone the timestamps are stored in")
        table(bool(profile.coverage_start), "recommended", "coverage_start", "Set the first date with data")

    table(profile.default_filters_confirmed, "recommended", "default_filters",
          "Confirm the default filters (or confirm that none are needed)")
    if profile.table_kind == TableKind.FACT:
        table(relationship_count > 0, "recommended", "relationships", "Add relationships to the lookup tables")

    for col, cp in columns:
        if not col.get("is_exposed") or col.get("is_deprecated"):
            continue
        cid, cname = col["_id"], col["physical_name"]

        def column(ok: bool, level: Level, field: str, message: str) -> None:
            b.check(ok, level, "column", cid, cname, field, message)

        role, semantic = col.get("role"), col.get("semantic_type")
        column(role is not None, "required", "role", "Choose the role (key, dimension or measure)")
        column(semantic is not None, "required", "semantic_type", "Choose the semantic type")
        column(bool(col.get("description")), "recommended", "description", "Describe the column")
        column(
            (col.get("display_name") or cname) != cname, "recommended", "display_name",
            "Give the column a readable name",
        )
        if role == "measure":
            column(col.get("default_aggregation") is not None, "required", "default_aggregation",
                   "Choose how to aggregate it")
            column(bool(cp.unit), "required", "unit", "Set the unit")
            column(cp.additive is not None, "required", "additive", "Say whether it can be summed")
            column(bool(cp.null_meaning), "recommended", "null_meaning", "Say what an empty value means")
        if semantic in ("category", "boolean"):
            column(bool(cp.value_catalog), "required", "value_catalog", "List the values and their meanings")
            if cp.value_catalog:
                column(all(item.label for item in cp.value_catalog), "recommended", "value_catalog",
                       "Give every value a label")
                column(cp.value_catalog_complete, "recommended", "value_catalog_complete",
                       "Confirm the list holds every value")
        if semantic in ("date", "datetime") and str(col.get("data_type", "")).upper() not in _DATE_TYPES:
            column(bool(cp.date_format), "required", "date_format",
                   f"Stored as {col.get('data_type')}: write the date format (e.g. YYYYMMDD)")
        if semantic == "id":
            column(bool(cp.pattern), "recommended", "pattern", "Give an example of the id format")

    return b.result
