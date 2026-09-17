from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

from src.database.models.enums import Cardinality, JoinType

if TYPE_CHECKING:
    from src.database.models.relationship_column_pair import RelationshipColumnPair


class EntityRelationship(SQLModel, table=True):
    __tablename__ = "relationships"

    id: int | None = Field(default=None, primary_key=True)

    from_entity_id: int = Field(foreign_key="entities.id", index=True)
    to_entity_id: int = Field(foreign_key="entities.id", index=True)

    # [curate]/[sync]
    cardinality: Cardinality = Field(default=Cardinality.ONE_TO_MANY)
    join_type_default: JoinType = Field(default=JoinType.LEFT)

    # derived: true when sourced from a real FK, false when human-inferred
    is_curated: bool = Field(default=False)

    column_pairs: list["RelationshipColumnPair"] = Relationship(back_populates="relationship")
