import functools
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.database.mongodb import AttrDatabase, AttrDict
from src.data_profile.search_index import mark_stale
from src.data_profile.service import flag_needs_review
from src.database.models.enums import EntityType, SourceStatus
from src.security import role as role_mod
from src.services.dremio_client import DremioClient

_TYPE_MAP = {
    "MYSQL": "mysql",
    "POSTGRES": "postgres",
    "S3": "s3",
    "NAS": "nas",
}

# Built-in Oracle schemas: dictionary/option tables that only add noise to the semantic layer.
_SYSTEM_SCHEMAS = {
    "ORACLE": {
        "ANONYMOUS", "APPQOSSYS", "AUDSYS", "CTXSYS", "DBSFWUSER", "DBSNMP", "DGPDB_INT", "DIP",
        "DVF", "DVSYS", "GGSYS", "GSMADMIN_INTERNAL", "GSMCATUSER", "GSMROOTUSER", "GSMUSER",
        "LBACSYS", "MDDATA", "MDSYS", "OJVMSYS", "OLAPSYS", "ORACLE_OCM", "ORDDATA",
        "ORDPLUGINS", "ORDSYS", "OUTLN", "REMOTE_SCHEDULER_AGENT", "SI_INFORMTN_SCHEMA", "SYS",
        "SYS$UMF", "SYSBACKUP", "SYSDG", "SYSKM", "SYSRAC", "SYSTEM", "WMSYS", "XDB", "XS$NULL",
    },
    # Ours (2026-10-06): the recursive sync otherwise imports — and exposes to the agent — every server
    # catalog of a MySQL source (measured: mysql 38 + performance_schema 114 tables per source).
    "MYSQL": {"mysql", "performance_schema", "information_schema", "sys"},
    "POSTGRES": {"pg_catalog", "information_schema", "pg_toast"},
    "MSSQL": {"sys", "INFORMATION_SCHEMA", "guest"},
}


def list_available_dremio_sources(
    client: DremioClient, container_types: tuple[str, ...] = ("SOURCE", "SPACE")
) -> list[dict[str, str]]:
    result = []
    for container in client.list_containers(container_types):
        if container.get("containerType") == "SPACE":
            result.append({"name": container["path"][0], "type": "space"})
            continue
        detail = client.get_catalog_entry(container["id"])
        result.append({"name": detail["name"], "type": _container_type(detail)})
    return result


def _list_source_datasets_impl(
    client: DremioClient, db: AttrDatabase, source_name: str
) -> list[dict[str, Any]]:
    """Every dataset in a source (minus built-in system schemas), flagged if already imported."""
    source_type = client.get_catalog_by_path([source_name]).get("type", "")
    skip_schemas = _SYSTEM_SCHEMAS.get(source_type, set())
    escaped = source_name.replace("'", "''")
    rows = client.run_sql_all(
        'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA."TABLES" '
        f"WHERE TABLE_SCHEMA = '{escaped}' OR TABLE_SCHEMA LIKE '{escaped}.%'"
    )

    data_source = data_source_crud.get_by_name(db, source_name)
    imported_paths = (
        entity_crud.list_physical_paths_by_data_source(db, data_source.id) if data_source else set()
    )

    datasets = []
    for row in rows:
        path = [*row["TABLE_SCHEMA"].split("."), row["TABLE_NAME"]]
        if path[0] != source_name or (len(path) > 2 and path[1] in skip_schemas):
            continue
        datasets.append(
            {
                "path": path,
                "schema_name": ".".join(path[1:-1]),
                "name": path[-1],
                "type": row["TABLE_TYPE"],
                "imported": ".".join(path) in imported_paths,
            }
        )
    datasets.sort(key=lambda d: (d["schema_name"], d["name"]))
    return datasets


def _sync_dremio_datasets_impl(
    client: DremioClient, db: AttrDatabase, datasets: list[list[str]]
) -> dict[str, Any]:
    """Imports/refreshes only the chosen datasets (full Dremio paths). Nothing is deprecated."""
    summary = {"sources": 0, "entities_added": 0, "entities_deprecated": 0, "columns_synced": 0}
    data_sources: dict[str, AttrDict] = {}

    for path in datasets:
        source_name = path[0]
        if source_name not in data_sources:
            source_detail = client.get_catalog_by_path([source_name])
            data_sources[source_name] = _upsert_data_source(db, source_detail)
            summary["sources"] += 1

        table_detail = client.get_catalog_by_path(path)
        _upsert_entity(db, data_sources[source_name], table_detail, summary)

    return summary


def _sync_dremio_metadata_impl(
    client: DremioClient,
    db: AttrDatabase,
    source_names: list[str] | None = None,
    container_types: tuple[str, ...] = ("SOURCE", "SPACE"),
) -> dict[str, Any]:
    summary = {"sources": 0, "entities_added": 0, "entities_deprecated": 0, "columns_synced": 0}

    seen_entity_ids: set[str] = set()
    synced_source_ids: set[str] = set()

    for source_summary in client.list_containers(container_types):
        if source_names is not None and source_summary["path"][0] not in source_names:
            continue

        # a full sync leaves soft-deleted sources alone; importing one by name restores it
        existing = data_source_crud.get_by_name(db, source_summary["path"][0])
        if source_names is None and existing is not None and existing.get("deleted_at"):
            continue

        source_detail = client.get_catalog_entry(source_summary["id"])
        data_source = _upsert_data_source(db, source_detail)
        summary["sources"] += 1
        synced_source_ids.add(data_source.id)
        skip_folders = _SYSTEM_SCHEMAS.get(source_detail.get("type", ""), set())

        for table_ref in _iter_datasets(client, source_detail, skip_folders):
            table_detail = client.get_catalog_entry(table_ref["id"])
            entity = _upsert_entity(db, data_source, table_detail, summary)
            seen_entity_ids.add(entity.id)

    # soft-delete entities that belong to sources synced in this run but were not seen
    all_entities = entity_crud.list_by_data_source_ids(db, list(synced_source_ids))
    for entity in all_entities:
        if entity.id not in seen_entity_ids and not entity.is_deprecated:
            entity_crud.update(db, entity.id, is_deprecated=True)
            summary["entities_deprecated"] += 1

    return summary


def _upsert_data_source(db: AttrDatabase, source_detail: dict[str, Any]) -> AttrDict:
    source_name = source_detail["name"]
    source_type = _container_type(source_detail)

    data_source = data_source_crud.get_by_name(db, source_name)

    if data_source is None:
        return data_source_crud.create(
            db,
            name=source_name,
            source_type=source_type,
            dremio_path=source_name,
            status=SourceStatus.CONNECTED,
            last_synced_at=datetime.now(UTC),
            is_exposed_to_agent=True,
        )
    return data_source_crud.update(
        db, data_source.id,
        source_type=source_type, status=SourceStatus.CONNECTED,
        last_synced_at=datetime.now(UTC), deleted_at=None,
    )


def _upsert_entity(
    db: AttrDatabase, data_source: AttrDict, table_detail: dict[str, Any], summary: dict[str, Any]
) -> AttrDict:
    table_name = table_detail["path"][-1]
    physical_path = ".".join(table_detail["path"])
    entity_type = EntityType.VDS if table_detail.get("type") == "VIRTUAL_DATASET" else EntityType.TABLE

    entity = entity_crud.get_by_physical_path(db, data_source.id, physical_path)

    if entity is None:
        entity = entity_crud.create(
            db,
            data_source_id=data_source.id,
            physical_path=physical_path,
            physical_name=table_name,
            entity_type=entity_type,
            display_name=table_name,
            is_exposed=True,
        )
        summary["entities_added"] += 1
    else:
        entity = entity_crud.update(
            db, entity.id,
            entity_type=entity_type, is_deprecated=False, last_synced_at=datetime.now(UTC),
        )

    fields = table_detail.get("fields", [])
    _sync_columns(db, entity, fields)
    summary["columns_synced"] += len(fields)
    return entity


def _container_type(detail: dict[str, Any]) -> str:
    """A source's connector type (mysql, oracle…), or 'space' for a space of views."""
    if detail.get("entityType") == "space":
        return "space"
    return _TYPE_MAP.get(detail.get("type", ""), detail.get("type", "").lower())


def _iter_datasets(
    client: DremioClient, container: dict[str, Any], skip_folders: set[str]
) -> Iterator[dict[str, Any]]:
    """Yields every dataset under a source or space, descending through folders (e.g. Oracle schemas)."""
    for child in container.get("children", []):
        if child.get("type") == "DATASET":
            yield child
        elif child.get("containerType") == "FOLDER" and child["path"][-1] not in skip_folders:
            yield from _iter_datasets(client, client.get_catalog_entry(child["id"]), skip_folders)


def _sync_columns(db: AttrDatabase, entity: AttrDict, fields: list[dict[str, Any]]) -> None:
    existing_columns = {
        col.physical_name: col
        for col in entity_column_crud.list_by_entity_all(db, entity.id)
    }
    seen_names: set[str] = set()
    # column changes that make the human-entered profile worth another look
    review_reasons: list[str] = []

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
            if existing_columns:
                review_reasons.append(f"New column: {name}")
        else:
            if column.is_deprecated:
                review_reasons.append(f"Column is back: {name}")
            elif column.data_type != data_type:
                review_reasons.append(f"Type changed: {name} {column.data_type} → {data_type}")
            entity_column_crud.update(
                db, column.id,
                data_type=data_type, ordinal=ordinal, is_deprecated=False,
                last_synced_at=datetime.now(UTC),
            )

    for name, column in existing_columns.items():
        if name not in seen_names and not column.is_deprecated:
            entity_column_crud.update(db, column.id, is_deprecated=True)
            review_reasons.append(f"Column removed: {name}")

    flag_needs_review(db, entity.id, review_reasons)
    if review_reasons:
        mark_stale(db, entity.id, "columns changed in Dremio")


# --- role wrappers (ours; the reference has no roles) -------------------------------------------------------
# Admin operations: they must see the FULL catalog whoever calls them (src/security/role.py), or a sync would
# miss — and then deprecate — tables hidden from the caller's role.
def _as_admin(impl):
    @functools.wraps(impl)
    def run(*args, **kwargs):
        with role_mod.as_role(role_mod.ADMIN):
            return impl(*args, **kwargs)
    return run


list_source_datasets = _as_admin(_list_source_datasets_impl)
sync_dremio_datasets = _as_admin(_sync_dremio_datasets_impl)
sync_dremio_metadata = _as_admin(_sync_dremio_metadata_impl)
