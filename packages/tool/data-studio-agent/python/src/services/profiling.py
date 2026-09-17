from datetime import UTC, datetime
from typing import Any

from sqlmodel import Session, select

from src.database.models import Entity, EntityColumn
from src.services.dremio_client import DremioClient, DremioQueryError

SAMPLE_VALUES_LIMIT = 20


def profile_entity(client: DremioClient, session: Session, entity: Entity) -> dict[str, Any]:
    columns = session.exec(
        select(EntityColumn).where(
            EntityColumn.entity_id == entity.id,
            EntityColumn.is_deprecated == False,  # noqa: E712
        )
    ).all()

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
        column.distinct_count = col_stats["distinct_count"]
        column.null_ratio = round((total - non_null) / total, 4) if total > 0 else 0.0
        column.min_val = _stringify(col_stats["min_val"])
        column.max_val = _stringify(col_stats["max_val"])

        if not column.is_pii:
            column.sample_values = _sample_values(client, entity.physical_path, column.physical_name)

        column.last_profiled_at = now
        session.add(column)
        columns_profiled += 1

    row_count = next(iter(stats.values()))["total"] if stats else None
    entity.row_count_est = row_count
    entity.last_profiled_at = now
    session.add(entity)

    session.commit()
    return {"entity": entity.physical_name, "columns_profiled": columns_profiled, "row_count": row_count}


def profile_all_entities(
    client: DremioClient, session: Session, entity_ids: list[int] | None = None
) -> list[dict[str, Any]]:
    query = select(Entity).where(
        Entity.is_exposed == True,  # noqa: E712
        Entity.is_deprecated == False,  # noqa: E712
    )
    if entity_ids is not None:
        query = query.where(Entity.id.in_(entity_ids))

    entities = session.exec(query).all()

    results = []
    for entity in entities:
        try:
            results.append(profile_entity(client, session, entity))
        except DremioQueryError as err:
            results.append({"entity": entity.physical_name, "error": str(err)})

    return results


def _profile_column_stats(
    client: DremioClient, physical_path: str, columns: list[EntityColumn]
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
