"""Export the profile to JSON files and import them (into this or another installation).

  GET  /data-profile/data-sources/{id}/export.json   tables + columns of one data source
  POST /data-profile/data-sources/{id}/import        into that data source
  GET  /data-profile/relationships/export.json       POST /data-profile/relationships/import
  GET  /data-profile/metrics/export.json             POST /data-profile/metrics/import
  GET  /data-profile/glossary/export.json            POST /data-profile/glossary/import

Imports take the exported file as the body; ?dry_run=true reports what would happen and writes
nothing. Registered before the data-profile router so ".../export.json" is not read as an id.
"""

import json
import re
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, Body, HTTPException, Response, status

from src.apis.deps import CurrentUserDep, MongoDep, SettingsDep
from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.data_profile import glossary as glossary_service
from src.data_profile import metrics as metric_service
from src.data_profile import transfer
from src.data_profile.search_index import (
    run_glossary_indexing,
    run_indexing,
    run_metric_indexing,
)
from src.data_profile.transfer import ImportReport, TransferError

router = APIRouter(prefix="/data-profile", tags=["data-profile"])
FileBody = Annotated[dict[str, Any], Body(description="an exported profile file")]


def _download(data: dict[str, Any], name: str) -> Response:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-") or "profile"
    filename = f"{slug}.json"
    return Response(
        content=json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}"},
    )


def _source(db: MongoDep, data_source_id: str) -> dict[str, Any]:
    source = data_source_crud.get_by_id(db, data_source_id)
    if source is None or source.get("deleted_at"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data source not found")
    return source


def _run(fn: Any, *args: Any) -> ImportReport:
    try:
        return fn(*args)
    except TransferError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err


def _indexed(doc: dict[str, Any] | None) -> bool:
    return doc is None or (doc.get("search_index") or {}).get("status") == "ok"


def _reindex(db: MongoDep, settings: SettingsDep, report: ImportReport) -> ImportReport:
    """Imported items are searched by the agents (Meilisearch): index them like a save in the UI does,
    and name the ones that failed. Relationships are not in the search index (read from Mongo)."""
    for eid in report.changed_entity_ids:
        run_indexing(db, settings, eid, "entity")
        if not _indexed(doc := entity_crud.get_by_id(db, eid)):
            report.not_indexed.append(f"table {doc['physical_name']}")  # type: ignore[index]
    for mid in report.changed_metric_ids:
        run_metric_indexing(db, settings, mid)
        if not _indexed(doc := metric_service.get_doc(db, mid)):
            report.not_indexed.append(f"metric {doc['name']}")  # type: ignore[index]
    for tid in report.changed_term_ids:
        run_glossary_indexing(db, settings, tid)
        if not _indexed(doc := glossary_service.get_doc(db, tid)):
            report.not_indexed.append(f"term {doc['term']}")  # type: ignore[index]
    return report


@router.get("/data-sources/{data_source_id}/export.json")
def export_tables(data_source_id: str, current_user: CurrentUserDep, db: MongoDep) -> Response:
    source = _source(db, data_source_id)
    return _download(transfer.export_tables(db, source), f"tables-{source.get('name') or 'source'}")


@router.post("/data-sources/{data_source_id}/import", response_model=ImportReport)
def import_tables(data_source_id: str, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep,
                  data: FileBody, dry_run: bool = False) -> ImportReport:
    report = _run(transfer.import_tables, db, _source(db, data_source_id), data, dry_run)
    return _reindex(db, settings, report)


@router.get("/relationships/export.json")
def export_relationships(current_user: CurrentUserDep, db: MongoDep) -> Response:
    return _download(transfer.export_relationships(db), "relationships")


@router.post("/relationships/import", response_model=ImportReport)
def import_relationships(current_user: CurrentUserDep, db: MongoDep, data: FileBody,
                         dry_run: bool = False) -> ImportReport:
    return _run(transfer.import_relationships, db, data, dry_run)


@router.get("/metrics/export.json")
def export_metrics(current_user: CurrentUserDep, db: MongoDep) -> Response:
    return _download(transfer.export_metrics(db), "metrics")


@router.post("/metrics/import", response_model=ImportReport)
def import_metrics(current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep, data: FileBody,
                   dry_run: bool = False) -> ImportReport:
    return _reindex(db, settings, _run(transfer.import_metrics, db, data, dry_run))


@router.get("/glossary/export.json")
def export_glossary(current_user: CurrentUserDep, db: MongoDep) -> Response:
    return _download(transfer.export_glossary(db), "glossary")


@router.post("/glossary/import", response_model=ImportReport)
def import_glossary(current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep, data: FileBody,
                    dry_run: bool = False) -> ImportReport:
    return _reindex(db, settings, _run(transfer.import_glossary, db, data, dry_run))
