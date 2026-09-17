from datetime import UTC, datetime
from typing import Any

from sqlmodel import Session, select

from src.database.models import DataSource, Entity, EntityColumn
from src.database.models.enums import EntityType, SourceStatus
from src.services.dremio_client import DremioClient

_TYPE_MAP = {
    "MYSQL": "mysql",
    "POSTGRES": "postgres",
    "S3": "s3",
    "NAS": "nas",
}


def list_available_dremio_sources(client: DremioClient) -> list[dict[str, str]]:
    result = []
    for source in client.list_sources():
        detail = client.get_catalog_entry(source["id"])
        result.append(
            {
                "name": detail["name"],
                "type": _TYPE_MAP.get(detail.get("type", ""), detail.get("type", "").lower()),
            }
        )
    return result


def sync_dremio_metadata(
    client: DremioClient,
    session: Session,
    source_names: list[str] | None = None,
) -> dict[str, Any]:
    summary = {"sources": 0, "entities_added": 0, "entities_deprecated": 0, "columns_synced": 0}

    seen_entity_ids: set[int] = set()

    for source_summary in client.list_sources():
        if source_names is not None and source_summary["path"][0] not in source_names:
            continue

        source_id = source_summary["id"]
        source_detail = client.get_catalog_entry(source_id)
        source_name = source_detail["name"]
        source_type = _TYPE_MAP.get(source_detail.get("type", ""), source_detail.get("type", "").lower())

        data_source = session.exec(
            select(DataSource).where(DataSource.name == source_name)
        ).first()

        if data_source is None:
            data_source = DataSource(
                name=source_name,
                source_type=source_type,
                dremio_path=source_name,
                status=SourceStatus.CONNECTED,
                last_synced_at=datetime.now(UTC),
                is_exposed_to_agent=True,
            )
            session.add(data_source)
            session.flush()
        else:
            data_source.source_type = source_type
            data_source.status = SourceStatus.CONNECTED
            data_source.last_synced_at = datetime.now(UTC)

        summary["sources"] += 1

        schema_name = source_detail.get("config", {}).get("database", source_name)
        schema_folder = next(
            (
                child
                for child in source_detail.get("children", [])
                if child.get("containerType") == "FOLDER" and child["path"][-1] == schema_name
            ),
            None,
        )
        if schema_folder is None:
            continue

        schema_detail = client.get_catalog_entry(schema_folder["id"])

        for table_ref in schema_detail.get("children", []):
            if table_ref.get("type") != "DATASET":
                continue

            table_detail = client.get_catalog_entry(table_ref["id"])
            table_name = table_detail["path"][-1]
            physical_path = ".".join(table_detail["path"])

            entity = session.exec(
                select(Entity).where(
                    Entity.data_source_id == data_source.id,
                    Entity.physical_name == table_name,
                )
            ).first()

            if entity is None:
                entity = Entity(
                    data_source_id=data_source.id,
                    physical_path=physical_path,
                    physical_name=table_name,
                    entity_type=EntityType.TABLE,
                    display_name=table_name,
                    is_exposed=True,
                )
                session.add(entity)
                session.flush()
                summary["entities_added"] += 1
            else:
                entity.physical_path = physical_path
                entity.is_deprecated = False
                entity.last_synced_at = datetime.now(UTC)

            seen_entity_ids.add(entity.id)

            _sync_columns(session, entity, table_detail.get("fields", []))
            summary["columns_synced"] += len(table_detail.get("fields", []))

    # soft-delete entities that belong to synced sources but were not seen this run
    synced_source_ids = [
        ds.id for ds in session.exec(select(DataSource)).all() if ds.last_synced_at is not None
    ]
    all_entities = session.exec(
        select(Entity).where(Entity.data_source_id.in_(synced_source_ids))
    ).all()
    for entity in all_entities:
        if entity.id not in seen_entity_ids and not entity.is_deprecated:
            entity.is_deprecated = True
            summary["entities_deprecated"] += 1

    session.commit()
    return summary


def _sync_columns(session: Session, entity: Entity, fields: list[dict[str, Any]]) -> None:
    existing_columns = {
        col.physical_name: col
        for col in session.exec(
            select(EntityColumn).where(EntityColumn.entity_id == entity.id)
        ).all()
    }
    seen_names: set[str] = set()

    for ordinal, field in enumerate(fields, start=1):
        name = field["name"]
        data_type = field.get("type", {}).get("name", "UNKNOWN")
        seen_names.add(name)

        column = existing_columns.get(name)
        if column is None:
            column = EntityColumn(
                entity_id=entity.id,
                physical_name=name,
                data_type=data_type,
                ordinal=ordinal,
                display_name=name,
                is_exposed=True,
            )
            session.add(column)
        else:
            column.data_type = data_type
            column.ordinal = ordinal
            column.is_deprecated = False
            column.last_synced_at = datetime.now(UTC)

    for name, column in existing_columns.items():
        if name not in seen_names and not column.is_deprecated:
            column.is_deprecated = True
