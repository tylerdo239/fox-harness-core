from datetime import UTC, datetime
from typing import Any

from src.crud_mongo import data_source as data_source_crud
from src.security import role as role_mod
from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.database.mongodb import AttrDatabase, AttrDict
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


def _sync_dremio_metadata_impl(
    client: DremioClient,
    db: AttrDatabase,
    source_names: list[str] | None = None,
) -> dict[str, Any]:
    summary = {"sources": 0, "entities_added": 0, "entities_deprecated": 0, "columns_synced": 0}

    seen_entity_ids: set[str] = set()

    for source_summary in client.list_sources():
        if source_names is not None and source_summary["path"][0] not in source_names:
            continue

        source_id = source_summary["id"]
        source_detail = client.get_catalog_entry(source_id)
        source_name = source_detail["name"]
        source_type = _TYPE_MAP.get(source_detail.get("type", ""), source_detail.get("type", "").lower())

        data_source = data_source_crud.get_by_name(db, source_name)

        if data_source is None:
            data_source = data_source_crud.create(
                db,
                name=source_name,
                source_type=source_type,
                dremio_path=source_name,
                status=SourceStatus.CONNECTED,
                last_synced_at=datetime.now(UTC),
                is_exposed_to_agent=True,
            )
        else:
            data_source = data_source_crud.update(
                db, data_source.id,
                source_type=source_type, status=SourceStatus.CONNECTED,
                last_synced_at=datetime.now(UTC),
            )

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

            entity = entity_crud.get_by_physical_name(db, data_source.id, table_name)

            if entity is None:
                entity = entity_crud.create(
                    db,
                    data_source_id=data_source.id,
                    physical_path=physical_path,
                    physical_name=table_name,
                    entity_type=EntityType.TABLE,
                    display_name=table_name,
                    is_exposed=True,
                )
                summary["entities_added"] += 1
            else:
                entity = entity_crud.update(
                    db, entity.id,
                    physical_path=physical_path, is_deprecated=False, last_synced_at=datetime.now(UTC),
                )

            seen_entity_ids.add(entity.id)

            _sync_columns(db, entity, table_detail.get("fields", []))
            summary["columns_synced"] += len(table_detail.get("fields", []))

    # soft-delete entities that belong to synced sources but were not seen this run
    synced_source_ids = [
        ds.id for ds in data_source_crud.list_all(db) if ds.last_synced_at is not None
    ]
    all_entities = entity_crud.list_by_data_source_ids(db, synced_source_ids)
    for entity in all_entities:
        if entity.id not in seen_entity_ids and not entity.is_deprecated:
            entity_crud.update(db, entity.id, is_deprecated=True)
            summary["entities_deprecated"] += 1

    return summary


def _sync_columns(db: AttrDatabase, entity: AttrDict, fields: list[dict[str, Any]]) -> None:
    existing_columns = {
        col.physical_name: col
        for col in entity_column_crud.list_by_entity_all(db, entity.id)
    }
    seen_names: set[str] = set()

    for ordinal, field in enumerate(fields, start=1):
        name = field["name"]
        data_type = field.get("type", {}).get("name", "UNKNOWN")
        seen_names.add(name)

        column = existing_columns.get(name)
        if column is None:
            entity_column_crud.create(
                db,
                entity_id=entity.id,
                physical_name=name,
                data_type=data_type,
                ordinal=ordinal,
                display_name=name,
                is_exposed=True,
            )
        else:
            entity_column_crud.update(
                db, column.id,
                data_type=data_type, ordinal=ordinal, is_deprecated=False,
                last_synced_at=datetime.now(UTC),
            )

    for name, column in existing_columns.items():
        if name not in seen_names and not column.is_deprecated:
            entity_column_crud.update(db, column.id, is_deprecated=True)


def sync_dremio_metadata(
    client: DremioClient,
    db: AttrDatabase,
    source_names: list[str] | None = None,
) -> dict[str, Any]:
    """Admin operation: always sees the FULL catalog, whoever calls it (src/security/role.py)."""
    with role_mod.as_role(role_mod.ADMIN):
        return _sync_dremio_metadata_impl(client, db, source_names)
