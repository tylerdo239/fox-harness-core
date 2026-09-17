from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlmodel import Session, select

from src.database.models import (
    BusinessGlossaryTerm,
    Entity,
    EntityColumn,
    EntityRelationship,
)
from src.services.dremio_client import DremioClient
from src.services.profiling import profile_entity

STALENESS_THRESHOLD = timedelta(hours=24)


@dataclass
class ColumnFacts:
    id: int
    physical_name: str
    display_name: str
    sample_values: list
    distinct_count: int | None
    null_ratio: float | None
    min_val: str | None
    max_val: str | None
    value_glossary: dict[str, str]


@dataclass
class EntityFacts:
    id: int
    display_name: str
    grain_description: str | None
    row_count_est: int | None


@dataclass
class RelationshipFacts:
    from_entity_id: int
    to_entity_id: int
    cardinality: str


@dataclass
class GlossaryFacts:
    id: int
    term: str
    definition_text: str
    sql_expression: str | None


@dataclass
class GroundingResult:
    columns: list[ColumnFacts] = field(default_factory=list)
    entities: list[EntityFacts] = field(default_factory=list)
    relationships: list[RelationshipFacts] = field(default_factory=list)
    glossary_terms: list[GlossaryFacts] = field(default_factory=list)
    entities_reprofiled: list[str] = field(default_factory=list)


def ground_selection(
    session: Session,
    dremio_client: DremioClient,
    entity_ids: list[int],
    column_ids: list[int],
    glossary_term_ids: list[int] | None = None,
) -> GroundingResult:
    """Pure code, no LLM. Refreshes stale profiles, then pulls [profile] fields for the
    selected columns only, grain/cardinality for the selected entities, and matching
    glossary SQL expressions. This is the anti-hallucination grounding fuel for Step 4."""
    result = GroundingResult()

    entities = _load_entities(session, entity_ids)
    _refresh_stale_entities(session, dremio_client, entities, result)

    columns = _load_columns(session, column_ids)
    result.columns = [
        ColumnFacts(
            id=c.id,
            physical_name=c.physical_name,
            display_name=c.display_name,
            sample_values=c.sample_values,
            distinct_count=c.distinct_count,
            null_ratio=c.null_ratio,
            min_val=c.min_val,
            max_val=c.max_val,
            value_glossary=c.value_glossary,
        )
        for c in columns
    ]

    result.entities = [
        EntityFacts(
            id=e.id,
            display_name=e.display_name,
            grain_description=e.grain_description,
            row_count_est=e.row_count_est,
        )
        for e in entities
    ]

    result.relationships = _load_relationship_facts(session, entity_ids)

    if glossary_term_ids:
        result.glossary_terms = _load_glossary_facts(session, glossary_term_ids)

    return result


def _load_entities(session: Session, entity_ids: list[int]) -> list[Entity]:
    if not entity_ids:
        return []
    return session.exec(select(Entity).where(Entity.id.in_(entity_ids))).all()


def _load_columns(session: Session, column_ids: list[int]) -> list[EntityColumn]:
    if not column_ids:
        return []
    return session.exec(select(EntityColumn).where(EntityColumn.id.in_(column_ids))).all()


def _refresh_stale_entities(
    session: Session, dremio_client: DremioClient, entities: list[Entity], result: GroundingResult
) -> None:
    now = datetime.now(UTC)

    for entity in entities:
        is_stale = entity.last_profiled_at is None or (
            _as_aware(entity.last_profiled_at) < now - STALENESS_THRESHOLD
        )
        if is_stale:
            profile_entity(dremio_client, session, entity)
            result.entities_reprofiled.append(entity.physical_name)
            session.refresh(entity)


def _as_aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _load_relationship_facts(session: Session, entity_ids: list[int]) -> list[RelationshipFacts]:
    if len(entity_ids) < 2:
        return []

    entity_id_set = set(entity_ids)
    relationships = session.exec(
        select(EntityRelationship).where(
            EntityRelationship.from_entity_id.in_(entity_ids),
            EntityRelationship.to_entity_id.in_(entity_ids),
        )
    ).all()

    return [
        RelationshipFacts(
            from_entity_id=rel.from_entity_id,
            to_entity_id=rel.to_entity_id,
            cardinality=rel.cardinality.value,
        )
        for rel in relationships
        if rel.from_entity_id in entity_id_set and rel.to_entity_id in entity_id_set
    ]


def _load_glossary_facts(session: Session, term_ids: list[int]) -> list[GlossaryFacts]:
    terms = session.exec(
        select(BusinessGlossaryTerm).where(BusinessGlossaryTerm.id.in_(term_ids))
    ).all()

    return [
        GlossaryFacts(
            id=t.id,
            term=t.term,
            definition_text=t.definition_text,
            sql_expression=t.sql_expression,
        )
        for t in terms
    ]
