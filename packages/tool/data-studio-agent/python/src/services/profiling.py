from datetime import UTC, datetime
from typing import Any

from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.database.mongodb import AttrDatabase
from src.services.dremio_client import DremioClient, DremioQueryError

SAMPLE_VALUES_LIMIT = 20


def profile_entity(client: DremioClient, db: AttrDatabase, entity) -> dict[str, Any]:
    columns = entity_column_crud.list_by_entity_ids(db, [entity.id])

    if not columns:
        return {"entity": entity.physical_name, "columns_profiled": 0, "skipped": "no columns"}

    stats = _profile_column_stats(client, entity.physical_path, columns)

    now = datetime.now(UTC)
    columns_profiled = 0

    for column in columns:
        col_stats = stats.get(column.physical_name)
        if col_stats is None:
            continue

        total = col_stats["total"]
        non_null = col_stats["non_null"]
        update_fields = {
            "distinct_count": col_stats["distinct_count"],
            "null_ratio": round((total - non_null) / total, 4) if total > 0 else 0.0,
            "min_val": _stringify(col_stats["min_val"]),
            "max_val": _stringify(col_stats["max_val"]),
            "last_profiled_at": now,
        }
        if not column.is_pii:
            update_fields["sample_values"] = _sample_values(client, entity.physical_path, column.physical_name)

        entity_column_crud.update(db, column.id, **update_fields)
        columns_profiled += 1

    row_count = next(iter(stats.values()))["total"] if stats else None
    entity_crud.update(db, entity.id, row_count_est=row_count, last_profiled_at=now)

    return {"entity": entity.physical_name, "columns_profiled": columns_profiled, "row_count": row_count}


def profile_all_entities(
    client: DremioClient, db: AttrDatabase, entity_ids: list[str] | None = None
) -> list[dict[str, Any]]:
    entities = entity_crud.list_exposed_active(db)
    if entity_ids is not None:
        wanted = set(entity_ids)
        entities = [e for e in entities if e.id in wanted]

    results = []
    for entity in entities:
        try:
            results.append(profile_entity(client, db, entity))
        except DremioQueryError as err:
            results.append({"entity": entity.physical_name, "error": str(err)})

    return results


def _profile_column_stats(
    client: DremioClient, physical_path: str, columns: list
) -> dict[str, dict[str, Any]]:
    select_parts = ["COUNT(*) AS total_rows"]
    for col in columns:
        name = col.physical_name
        select_parts.append(f'COUNT("{name}") AS "{name}__non_null"')
        select_parts.append(f'COUNT(DISTINCT "{name}") AS "{name}__distinct"')
        select_parts.append(f'MIN("{name}") AS "{name}__min"')
        select_parts.append(f'MAX("{name}") AS "{name}__max"')

    sql = f"SELECT {', '.join(select_parts)} FROM {physical_path}"
    rows = client.run_sql(sql, timeout_sec=120)

    if not rows:
        return {}

    row = rows[0]
    total = row["total_rows"]

    result: dict[str, dict[str, Any]] = {}
    for col in columns:
        name = col.physical_name
        result[name] = {
            "total": total,
            "non_null": row.get(f"{name}__non_null", 0),
            "distinct_count": row.get(f"{name}__distinct"),
            "min_val": row.get(f"{name}__min"),
            "max_val": row.get(f"{name}__max"),
        }
    return result


def _sample_values(client: DremioClient, physical_path: str, column_name: str) -> list[Any]:
    sql = (
        f'SELECT DISTINCT "{column_name}" AS val FROM {physical_path} '
        f'WHERE "{column_name}" IS NOT NULL LIMIT {SAMPLE_VALUES_LIMIT}'
    )
    try:
        rows = client.run_sql(sql, timeout_sec=60)
    except DremioQueryError:
        return []
    return [row["val"] for row in rows]


def _stringify(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)
