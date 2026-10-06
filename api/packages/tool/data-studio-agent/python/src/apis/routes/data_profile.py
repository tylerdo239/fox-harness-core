"""Human-entered data profile for pipeline v4: tables, columns, relationships, review."""

import re
from typing import Any, Literal
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel

from src.apis.deps import CurrentUserDep, MongoDep, SettingsDep
from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.crud_mongo import relationship as relationship_crud
from src.crud_mongo._shared import set_disabled
from src.data_profile import glossary as glossary_service
from src.data_profile import metrics as metric_service
from src.data_profile import relationships as rel_service
from src.data_profile import service
from src.data_profile.checklist import Checklist
from src.data_profile.export_docx import build_docx
from src.data_profile.glossary import GlossaryError, GlossaryInput, GlossaryItem
from src.data_profile.metric_sql import (
    JsonFieldCheck,
    MetricRunError,
    MetricRunResult,
    check_json_field,
    run_metric,
)
from src.data_profile.metrics import MetricError, MetricInput, MetricItem
from src.data_profile.models import (
    ColumnProfile,
    EntityProfile,
    ProfileReview,
    RelationshipProfile,
)
from src.data_profile.relationships import (
    ColumnOption,
    RelationshipError,
    RelationshipInput,
    RelationshipItem,
    TableOption,
)
from src.data_profile.search_index import (
    run_glossary_indexing,
    run_indexing,
    run_metric_indexing,
)
from src.data_profile.service import ProfileError
from src.data_profile.suggest import (
    Field_,
    FieldSuggestion,
    SuggestError,
    Target,
    ValueSuggestion,
    suggest_field,
    suggest_glossary_field,
    suggest_metric_calculation,
    suggest_metric_field,
    suggest_value,
)
from src.database.models.enums import ColumnRole, DefaultAggregation, SemanticType

router = APIRouter(prefix="/data-profile", tags=["data-profile"])


class EntitySummary(BaseModel):
    entity_id: str
    display_name: str
    physical_name: str
    entity_type: str
    column_count: int
    table_kind: str | None
    required_done: int
    required_total: int
    recommended_done: int
    recommended_total: int
    review: ProfileReview
    search_index: "SearchIndexStatus"


class EntityInfo(BaseModel):
    id: str
    physical_name: str
    physical_path: str
    entity_type: str
    display_name: str
    description: str | None
    synonyms: list[str]
    grain_description: str | None
    is_exposed: bool
    is_pii: bool


class ColumnInfo(BaseModel):
    id: str
    physical_name: str
    data_type: str
    ordinal: int
    display_name: str
    description: str | None
    synonyms: list[str]
    role: ColumnRole | None
    semantic_type: SemanticType | None
    default_aggregation: DefaultAggregation | None
    is_exposed: bool
    is_pii: bool
    profile: ColumnProfile


class ColumnPair(BaseModel):
    from_column: str
    to_column: str


class RelationshipInfo(BaseModel):
    id: str
    direction: str
    from_entity_name: str
    to_entity_name: str
    other_entity_id: str
    other_entity_name: str
    cardinality: str | None
    join_type_default: str | None
    pairs: list[ColumnPair]
    profile: RelationshipProfile


class SearchIndexStatus(BaseModel):
    status: str = "never"   # never | ok | stale
    error: str | None = None
    updated_at: str | None = None


class SuggestFieldRequest(BaseModel):
    target: Target
    field: Field_
    column_id: str | None = None
    # the form's current, possibly unsaved values for the table/column, used as context
    draft: dict[str, Any] = {}


class SuggestValueRequest(BaseModel):
    column_id: str
    value: str
    # unsaved dialog values: display_name, description, values=[{value, label}]
    draft: dict[str, Any] = {}


class ReindexSummary(BaseModel):
    tables: int
    ok: int
    stale: int


class EntityProfileDetail(BaseModel):
    entity: EntityInfo
    profile: EntityProfile
    review: ProfileReview
    columns: list[ColumnInfo]
    relationships: list[RelationshipInfo]
    checklist: Checklist
    search_index: SearchIndexStatus


class EntityProfileUpdate(BaseModel):
    display_name: str
    description: str | None = None
    synonyms: list[str] = []
    grain_description: str | None = None
    is_exposed: bool = True
    is_pii: bool = False
    profile: EntityProfile


class ColumnProfileUpdate(BaseModel):
    display_name: str
    description: str | None = None
    synonyms: list[str] = []
    role: ColumnRole | None = None
    semantic_type: SemanticType | None = None
    default_aggregation: DefaultAggregation | None = None
    is_exposed: bool = True
    is_pii: bool = False
    profile: ColumnProfile


class ColumnProfileBulkItem(ColumnProfileUpdate):
    id: str


def _get_entity(db: MongoDep, entity_id: str):
    entity = entity_crud.get_by_id(db, entity_id)
    if entity is None or entity.get("is_deprecated"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Table not found")
    return entity


def _detail(db: MongoDep, entity) -> EntityProfileDetail:
    columns = service.entity_columns(db, entity.id)
    return EntityProfileDetail(
        entity=EntityInfo(
            id=entity.id,
            physical_name=entity.physical_name,
            physical_path=entity.physical_path,
            entity_type=entity.entity_type,
            display_name=entity.display_name,
            description=entity.get("description"),
            synonyms=entity.get("synonyms") or [],
            grain_description=entity.get("grain_description"),
            is_exposed=bool(entity.get("is_exposed")),
            is_pii=bool(entity.get("is_pii")),
        ),
        profile=service.entity_profile(entity),
        review=service.review_of(entity),
        columns=[
            ColumnInfo(
                id=c.id,
                physical_name=c.physical_name,
                data_type=c.get("data_type") or "UNKNOWN",
                ordinal=c.get("ordinal") or 0,
                display_name=c.get("display_name") or c.physical_name,
                description=c.get("description"),
                synonyms=c.get("synonyms") or [],
                role=c.get("role"),
                semantic_type=c.get("semantic_type"),
                default_aggregation=c.get("default_aggregation"),
                is_exposed=bool(c.get("is_exposed")),
                is_pii=bool(c.get("is_pii")),
                profile=service.column_profile(c),
            )
            for c in columns
        ],
        relationships=[RelationshipInfo(**r) for r in service.entity_relationships(db, entity.id)],
        checklist=service.checklist_for(db, entity),
        search_index=SearchIndexStatus(**(entity.get("search_index") or {})),
    )


def _bad_request(err: ProfileError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.errors)


@router.get("/data-sources/{data_source_id}/entities", response_model=list[EntitySummary])
def list_entity_summaries(data_source_id: str, current_user: CurrentUserDep, db: MongoDep) -> list[EntitySummary]:
    data_source = data_source_crud.get_by_id(db, data_source_id)
    if data_source is None or data_source.get("deleted_at"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data source not found")
    result = []
    for entity in entity_crud.list_by_data_source(db, data_source_id):
        checklist = service.checklist_for(db, entity)
        result.append(
            EntitySummary(
                entity_id=entity.id,
                display_name=entity.display_name,
                physical_name=entity.physical_name,
                entity_type=entity.entity_type,
                column_count=entity_column_crud.count_by_entity(db, entity.id),
                table_kind=service.entity_profile(entity).table_kind,
                required_done=checklist.required_done,
                required_total=checklist.required_total,
                recommended_done=checklist.recommended_done,
                recommended_total=checklist.recommended_total,
                review=service.review_of(entity),
                search_index=SearchIndexStatus(**(entity.get("search_index") or {})),
            )
        )
    return result


@router.get("/entities/{entity_id}", response_model=EntityProfileDetail)
def get_entity_profile(entity_id: str, current_user: CurrentUserDep, db: MongoDep) -> EntityProfileDetail:
    return _detail(db, _get_entity(db, entity_id))


@router.put("/entities/{entity_id}", response_model=EntityProfileDetail)
def update_entity_profile(
    entity_id: str,
    payload: EntityProfileUpdate,
    current_user: CurrentUserDep,
    settings: SettingsDep,
    db: MongoDep,
) -> EntityProfileDetail:
    before = _get_entity(db, entity_id)
    try:
        service.save_entity(db, before, payload.model_dump(exclude={"profile"}), payload.profile)
    except ProfileError as err:
        raise _bad_request(err) from err
    # visibility or the table name (copied onto column docs) changed → redo the columns too
    full = before.get("is_exposed") != payload.is_exposed or before.get("display_name") != payload.display_name
    run_indexing(db, settings, entity_id, "table", full=full)
    return _detail(db, _get_entity(db, entity_id))


@router.put("/entities/{entity_id}/columns/{column_id}", response_model=EntityProfileDetail)
def update_column_profile(
    entity_id: str,
    column_id: str,
    payload: ColumnProfileUpdate,
    current_user: CurrentUserDep,
    settings: SettingsDep,
    db: MongoDep,
) -> EntityProfileDetail:
    entity = _get_entity(db, entity_id)
    column = entity_column_crud.get_by_id(db, column_id)
    if column is None or column.entity_id != entity.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Column not found")
    try:
        service.save_column(db, column, payload.model_dump(mode="json", exclude={"profile"}), payload.profile)
    except ProfileError as err:
        raise _bad_request(err) from err
    run_indexing(db, settings, entity.id, "columns", column_ids=[column_id])
    return _detail(db, _get_entity(db, entity.id))


@router.put("/entities/{entity_id}/columns", response_model=EntityProfileDetail)
def update_column_profiles(
    entity_id: str,
    payload: list[ColumnProfileBulkItem],
    current_user: CurrentUserDep,
    settings: SettingsDep,
    db: MongoDep,
) -> EntityProfileDetail:
    """Save many columns at once (the columns grid). Nothing is saved if any column is invalid."""
    entity = _get_entity(db, entity_id)
    columns = {c.id: c for c in service.entity_columns(db, entity.id)}
    errors = []
    for item in payload:
        column = columns.get(item.id)
        if column is None:
            errors.append(f"column {item.id} does not belong to this table")
            continue
        errors += [
            f"{column.physical_name}: {e}"
            for e in service.validate_column_profile(item.profile, column, list(columns.values()))
        ]
    if errors:
        raise _bad_request(ProfileError(errors))
    for item in payload:
        service.save_column(
            db, columns[item.id], item.model_dump(mode="json", exclude={"id", "profile"}), item.profile
        )
    run_indexing(db, settings, entity.id, "columns", column_ids=[item.id for item in payload])
    return _detail(db, _get_entity(db, entity.id))


@router.put("/entities/{entity_id}/relationships/{relationship_id}", response_model=EntityProfileDetail)
def update_relationship_profile(
    entity_id: str,
    relationship_id: str,
    payload: RelationshipProfile,
    current_user: CurrentUserDep,
    db: MongoDep,
) -> EntityProfileDetail:
    entity = _get_entity(db, entity_id)
    rel = relationship_crud.get_by_id(db, relationship_id)
    if rel is None or entity.id not in (rel.from_entity_id, rel.to_entity_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Relationship not found")
    service.save_relationship_profile(db, rel, payload)
    return _detail(db, entity)


@router.post("/entities/{entity_id}/review", response_model=EntityProfileDetail)
def review_entity_profile(entity_id: str, current_user: CurrentUserDep, db: MongoDep) -> EntityProfileDetail:
    entity = _get_entity(db, entity_id)
    try:
        entity = service.mark_reviewed(db, entity, current_user)
    except ProfileError as err:
        raise _bad_request(err) from err
    return _detail(db, entity)


@router.post("/entities/{entity_id}/reindex", response_model=EntityProfileDetail)
def reindex_entity(
    entity_id: str, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> EntityProfileDetail:
    entity = _get_entity(db, entity_id)
    run_indexing(db, settings, entity.id, "entity")
    return _detail(db, _get_entity(db, entity.id))


@router.get("/data-sources/{data_source_id}/export.docx")
def export_data_source_docx(data_source_id: str, current_user: CurrentUserDep, db: MongoDep) -> Response:
    """The source's profile as a Word document (Vietnamese) for a data engineer to fill in."""
    source = data_source_crud.get_by_id(db, data_source_id)
    if source is None or source.get("deleted_at"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data source not found")
    content = build_docx(db, source)
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", source.get("name") or "nguon").strip("-") or "nguon"
    filename = f"ho-so-du-lieu-{slug}.docx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}"},
    )


@router.post("/data-sources/{data_source_id}/reindex", response_model=ReindexSummary)
def reindex_data_source(
    data_source_id: str, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> ReindexSummary:
    """Rebuild the search index for every table of a source (first setup, or after an outage)."""
    data_source = data_source_crud.get_by_id(db, data_source_id)
    if data_source is None or data_source.get("deleted_at"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data source not found")
    entities = entity_crud.list_by_data_source(db, data_source_id)
    ok = 0
    for entity in entities:
        run_indexing(db, settings, entity.id, "entity")
        ok += (entity_crud.get_by_id(db, entity.id).get("search_index") or {}).get("status") == "ok"
    return ReindexSummary(tables=len(entities), ok=ok, stale=len(entities) - ok)


@router.post("/entities/{entity_id}/suggest-field", response_model=FieldSuggestion)
def suggest_profile_field(
    entity_id: str,
    payload: SuggestFieldRequest,
    current_user: CurrentUserDep,
    settings: SettingsDep,
    db: MongoDep,
) -> FieldSuggestion:
    """AI suggestion for one field, from metadata only. Returned to the form; nothing is saved."""
    entity = _get_entity(db, entity_id)
    try:
        return suggest_field(
            db, settings, entity,
            target=payload.target, field=payload.field,
            column_id=payload.column_id, draft=payload.draft,
        )
    except ValueError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except SuggestError as err:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(err)) from err


@router.post("/entities/{entity_id}/suggest-value", response_model=ValueSuggestion)
def suggest_value_label(
    entity_id: str,
    payload: SuggestValueRequest,
    current_user: CurrentUserDep,
    settings: SettingsDep,
    db: MongoDep,
) -> ValueSuggestion:
    """AI label and synonyms for one value of a column's value list. Nothing is saved."""
    entity = _get_entity(db, entity_id)
    try:
        return suggest_value(
            db, settings, entity, column_id=payload.column_id, value=payload.value, draft=payload.draft
        )
    except ValueError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except SuggestError as err:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(err)) from err


# ── relationships page (tables may be in different data sources) ──

@router.get("/tables", response_model=list[TableOption])
def list_tables(current_user: CurrentUserDep, db: MongoDep) -> list[TableOption]:
    """Every active table of every active data source, for the relationship table pickers."""
    return rel_service.table_options(db)


@router.get("/tables/{entity_id}/columns", response_model=list[ColumnOption])
def list_table_columns(entity_id: str, current_user: CurrentUserDep, db: MongoDep) -> list[ColumnOption]:
    return rel_service.column_options(db, _get_entity(db, entity_id))


@router.get("/relationships", response_model=list[RelationshipItem])
def list_relationship_items(current_user: CurrentUserDep, db: MongoDep) -> list[RelationshipItem]:
    return rel_service.list_items(db)


@router.post("/relationships", response_model=RelationshipItem, status_code=status.HTTP_201_CREATED)
def create_relationship_item(
    payload: RelationshipInput, current_user: CurrentUserDep, db: MongoDep
) -> RelationshipItem:
    try:
        return rel_service.create(db, payload)
    except RelationshipError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.errors) from err


@router.put("/relationships/{relationship_id}", response_model=RelationshipItem)
def update_relationship_item(
    relationship_id: str, payload: RelationshipInput, current_user: CurrentUserDep, db: MongoDep
) -> RelationshipItem:
    rel = relationship_crud.get_by_id(db, relationship_id)
    if rel is None or rel.get("deleted_at"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Relationship not found")
    try:
        return rel_service.update(db, relationship_id, payload)
    except RelationshipError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.errors) from err


@router.delete("/relationships/{relationship_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_relationship_item(relationship_id: str, current_user: CurrentUserDep, db: MongoDep) -> None:
    """Soft delete (deleted_at); the relationship disappears from every list and join."""
    if not rel_service.soft_delete(db, relationship_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Relationship not found")


# ── metrics ──

def _metric_or_404(db: MongoDep, metric_id: str):
    doc = metric_service.get_doc(db, metric_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Metric not found")
    return doc


@router.get("/metrics", response_model=list[MetricItem])
def list_metrics(current_user: CurrentUserDep, db: MongoDep) -> list[MetricItem]:
    return metric_service.list_items(db)


class SuggestMetricFieldRequest(BaseModel):
    field: Literal["description", "synonyms", "example_questions"]
    # the metric form's current values (the metric may not be saved yet)
    draft: dict[str, Any] = {}


@router.post("/metrics/suggest-field", response_model=FieldSuggestion)
def suggest_metric_profile_field(
    payload: SuggestMetricFieldRequest, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> FieldSuggestion:
    """AI description, synonyms or example questions for a metric, from its definition only. Nothing is saved."""
    try:
        return suggest_metric_field(db, settings, field=payload.field, draft=payload.draft)
    except ValueError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except SuggestError as err:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(err)) from err


class SuggestMetricCalculationRequest(BaseModel):
    field: Literal["aggregation", "column"]
    draft: dict[str, Any] = {}


@router.post("/metrics/suggest-calculation", response_model=FieldSuggestion)
def suggest_metric_profile_calculation(
    payload: SuggestMetricCalculationRequest, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> FieldSuggestion:
    """AI aggregation + column (or only the column) for an aggregate metric. Nothing is saved."""
    try:
        return suggest_metric_calculation(db, settings, field=payload.field, draft=payload.draft)
    except ValueError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except SuggestError as err:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(err)) from err


class RunMetricRequest(BaseModel):
    draft: dict[str, Any]       # the metric form's current values
    period: str | None = None   # "2026", "2026-08" or "2026-08-31"; empty = whole table


@router.post("/metrics/run", response_model=MetricRunResult)
def run_metric_sql(
    payload: RunMetricRequest, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> MetricRunResult:
    """Build the metric's SQL and run it once on Dremio (read-only), when a person presses Run."""
    try:
        return run_metric(db, settings, payload.draft, payload.period)
    except MetricRunError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except httpx.HTTPError as err:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Dremio is unreachable: {err}") from err


@router.get("/metrics/{metric_id}", response_model=MetricItem)
def get_metric(metric_id: str, current_user: CurrentUserDep, db: MongoDep) -> MetricItem:
    return metric_service.to_item(db, _metric_or_404(db, metric_id))


@router.post("/metrics", response_model=MetricItem, status_code=status.HTTP_201_CREATED)
def create_metric(
    payload: MetricInput, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> MetricItem:
    try:
        doc = metric_service.create(db, payload)
    except MetricError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.errors) from err
    run_metric_indexing(db, settings, doc["_id"])
    return metric_service.to_item(db, _metric_or_404(db, doc["_id"]))


@router.put("/metrics/{metric_id}", response_model=MetricItem)
def update_metric(
    metric_id: str, payload: MetricInput, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> MetricItem:
    _metric_or_404(db, metric_id)
    try:
        metric_service.update(db, metric_id, payload)
    except MetricError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.errors) from err
    run_metric_indexing(db, settings, metric_id)
    return metric_service.to_item(db, _metric_or_404(db, metric_id))


@router.delete("/metrics/{metric_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_metric(metric_id: str, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep) -> None:
    """Soft delete (deleted_at). Refused while a ratio metric is built from it."""
    _metric_or_404(db, metric_id)
    try:
        metric_service.soft_delete(db, metric_id)
    except MetricError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.errors) from err
    run_metric_indexing(db, settings, metric_id, remove=True)


class EnabledRequest(BaseModel):
    enabled: bool


@router.put("/metrics/{metric_id}/enabled", response_model=MetricItem)
def set_metric_enabled(metric_id: str, payload: EnabledRequest, current_user: CurrentUserDep,
                       db: MongoDep) -> MetricItem:
    """Turn a metric on or off for the agents (a disabled metric stays in the profile, unused)."""
    _metric_or_404(db, metric_id)
    set_disabled(db, metric_service.COLLECTION, metric_id, not payload.enabled)
    return metric_service.to_item(db, _metric_or_404(db, metric_id))


# ── business glossary ──

def _term_or_404(db: MongoDep, term_id: str):
    doc = glossary_service.get_doc(db, term_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Term not found")
    return doc


class SuggestGlossaryFieldRequest(BaseModel):
    field: Literal["definition", "synonyms", "example_questions"]
    draft: dict[str, Any] = {}


class RunSegmentRequest(BaseModel):
    entity_id: str
    filters: list[dict[str, Any]] = []
    period: str | None = None


@router.get("/glossary", response_model=list[GlossaryItem])
def list_glossary(current_user: CurrentUserDep, db: MongoDep) -> list[GlossaryItem]:
    return glossary_service.list_items(db)


@router.post("/glossary/suggest-field", response_model=FieldSuggestion)
def suggest_glossary_profile_field(
    payload: SuggestGlossaryFieldRequest, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> FieldSuggestion:
    """AI definition, synonyms or example questions for a term, from metadata only. Nothing is saved."""
    try:
        return suggest_glossary_field(db, settings, field=payload.field, draft=payload.draft)
    except ValueError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except SuggestError as err:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(err)) from err


@router.post("/glossary/run", response_model=MetricRunResult)
def run_segment(
    payload: RunSegmentRequest, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> MetricRunResult:
    """Count the rows in a segment once on Dremio (read-only), when a person presses Run."""
    draft = {
        "name": "segment_rows", "display_name": "segment rows", "kind": "aggregate",
        "entity_id": payload.entity_id, "aggregation": "count", "filters": payload.filters,
        "use_table_default_filters": True,
    }
    try:
        return run_metric(db, settings, draft, payload.period)
    except MetricRunError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except httpx.HTTPError as err:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Dremio is unreachable: {err}") from err


@router.post("/glossary", response_model=GlossaryItem, status_code=status.HTTP_201_CREATED)
def create_glossary_term(
    payload: GlossaryInput, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> GlossaryItem:
    try:
        doc = glossary_service.create(db, payload)
    except GlossaryError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.errors) from err
    run_glossary_indexing(db, settings, doc["_id"])
    return glossary_service.to_item(db, _term_or_404(db, doc["_id"]))


@router.put("/glossary/{term_id}", response_model=GlossaryItem)
def update_glossary_term(
    term_id: str, payload: GlossaryInput, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep
) -> GlossaryItem:
    _term_or_404(db, term_id)
    try:
        glossary_service.update(db, term_id, payload)
    except GlossaryError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err.errors) from err
    run_glossary_indexing(db, settings, term_id)
    return glossary_service.to_item(db, _term_or_404(db, term_id))


@router.put("/glossary/{term_id}/enabled", response_model=GlossaryItem)
def set_glossary_term_enabled(term_id: str, payload: EnabledRequest, current_user: CurrentUserDep,
                              db: MongoDep) -> GlossaryItem:
    """Turn a term on or off for the agents (a disabled term stays in the profile, unused)."""
    _term_or_404(db, term_id)
    set_disabled(db, glossary_service.COLLECTION, term_id, not payload.enabled)
    return glossary_service.to_item(db, _term_or_404(db, term_id))


@router.delete("/glossary/{term_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_glossary_term(term_id: str, current_user: CurrentUserDep, settings: SettingsDep, db: MongoDep) -> None:
    """Soft delete (deleted_at)."""
    _term_or_404(db, term_id)
    glossary_service.soft_delete(db, term_id)
    run_glossary_indexing(db, settings, term_id, remove=True)


class JsonFieldCheckRequest(BaseModel):
    path: str
    data_type: str


@router.post("/entities/{entity_id}/columns/{column_id}/check-json-field", response_model=JsonFieldCheck)
def check_column_json_field(
    entity_id: str,
    column_id: str,
    payload: JsonFieldCheckRequest,
    current_user: CurrentUserDep,
    settings: SettingsDep,
    db: MongoDep,
) -> JsonFieldCheck:
    """Count the rows that have this JSON field, once, when a person clicks Check (counts only)."""
    entity = _get_entity(db, entity_id)
    column = entity_column_crud.get_by_id(db, column_id)
    if column is None or column.entity_id != entity.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Column not found")
    try:
        return check_json_field(settings, entity, column, payload.path, payload.data_type)
    except MetricRunError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except httpx.HTTPError as err:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Dremio is unreachable: {err}") from err
