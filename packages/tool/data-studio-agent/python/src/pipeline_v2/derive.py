"""Runtime derivation of the per-entity 'identifier column', 'display-name column', and
'default select columns' the design doc (A.1) assumes as stored metadata.

We deliberately do NOT add these as DB columns (reuse-infra, no-migration decision). Instead
we compute them on the fly from the curated role/semantic_type/name signals already present
on EntityColumn. Kept in one place so the heuristics are consistent across steps 4 and 7.
"""

from sqlmodel import Session, select

from src.database.models import EntityColumn
from src.database.models.enums import ColumnRole, SemanticType

# Column names that, by convention, hold a human-readable label for a row.
_NAME_LIKE = ("name", "title", "label", "display_name", "full_name", "username")


def exposed_columns(session: Session, entity_id: int) -> list[EntityColumn]:
    return list(
        session.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == entity_id,
                EntityColumn.is_exposed == True,  # noqa: E712
                EntityColumn.is_deprecated == False,  # noqa: E712
            ).order_by(EntityColumn.ordinal)
        ).all()
    )


def identifier_column(session: Session, entity_id: int) -> EntityColumn | None:
    """The column that uniquely identifies a row — used for GROUP BY and as a JOIN key.
    Preference: a KEY-role / ID-semantic column, else the lowest-ordinal column named 'id'."""
    cols = exposed_columns(session, entity_id)
    for c in cols:
        if c.role == ColumnRole.KEY or c.semantic_type == SemanticType.ID:
            return c
    for c in cols:
        if c.physical_name.lower() in ("id", "pk"):
            return c
    # fall back to lowest-ordinal column so callers always get *something* stable to group on
    return cols[0] if cols else None


def display_name_column(session: Session, entity_id: int) -> EntityColumn | None:
    """The human-readable label column for SELECT, per design doc A.1 fallback ladder:
    (1) a name/title/label-named column, (2) a high-cardinality TEXT non-key column,
    (3) None (caller then falls back to the identifier column)."""
    cols = exposed_columns(session, entity_id)

    for c in cols:
        if c.physical_name.lower() in _NAME_LIKE:
            return c

    # (2) first exposed TEXT-semantic, non-key column — a readable attribute, not an id
    for c in cols:
        if (
            c.semantic_type == SemanticType.TEXT
            and c.role != ColumnRole.KEY
        ):
            return c

    return None


def default_select_columns(session: Session, entity_id: int) -> list[int]:
    """The 'worth showing' columns when the user lists rows without naming columns.
    identifier + display-name at minimum, so we never return a bare id with no label."""
    ids: list[int] = []
    ident = identifier_column(session, entity_id)
    label = display_name_column(session, entity_id)
    if label is not None and label.id is not None:
        ids.append(label.id)
    if ident is not None and ident.id is not None and ident.id not in ids:
        ids.append(ident.id)
    return ids
