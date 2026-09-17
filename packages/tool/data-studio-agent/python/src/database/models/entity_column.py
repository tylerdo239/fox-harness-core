from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, Relationship, SQLModel

from src.database.models.enums import ColumnRole, DefaultAggregation, SemanticType

if TYPE_CHECKING:
    from src.database.models.entity import Entity


class EntityColumn(SQLModel, table=True):
    __tablename__ = "entity_columns"

    id: int | None = Field(default=None, primary_key=True)

    # [sync]
    entity_id: int = Field(foreign_key="entities.id", index=True)
    physical_name: str
    data_type: str
    ordinal: int
    is_nullable: bool = Field(default=True)
    is_deprecated: bool = Field(default=False)
    last_synced_at: datetime | None = None

    # [curate]
    display_name: str
    description: str | None = None
    synonyms: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    role: ColumnRole | None = None
    semantic_type: SemanticType | None = None
    default_aggregation: DefaultAggregation | None = None
    value_glossary: dict[str, str] = Field(default_factory=dict, sa_column=Column(JSON))
    is_exposed: bool = Field(default=False)
    is_pii: bool = Field(default=False)
    # when true, this column is ALWAYS added to the SELECT for any query touching its entity,
    # regardless of whether the planning LLM chose it — a curator's override for columns the
    # model tends to omit but the user always wants to see.
    is_default_select: bool = Field(default=False)

    # [profile]
    distinct_count: int | None = None
    sample_values: list[Any] = Field(default_factory=list, sa_column=Column(JSON))
    min_val: str | None = None
    max_val: str | None = None
    null_ratio: float | None = None
    last_profiled_at: datetime | None = None

    entity: "Entity" = Relationship(back_populates="columns")
