from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from src.database.models.relationship import EntityRelationship


class RelationshipColumnPair(SQLModel, table=True):
    __tablename__ = "relationship_column_pairs"

    id: int | None = Field(default=None, primary_key=True)

    relationship_id: int = Field(foreign_key="relationships.id", index=True)
    from_column_id: int = Field(foreign_key="entity_columns.id")
    to_column_id: int = Field(foreign_key="entity_columns.id")
    seq: int = Field(default=0)

    relationship: "EntityRelationship" = Relationship(back_populates="column_pairs")
