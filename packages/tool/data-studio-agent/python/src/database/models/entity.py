from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Column
from sqlmodel import Field, Relationship, SQLModel

from src.database.models.enums import EntityType

if TYPE_CHECKING:
    from src.database.models.data_source import DataSource
    from src.database.models.entity_column import EntityColumn


class Entity(SQLModel, table=True):
    __tablename__ = "entities"

    id: int | None = Field(default=None, primary_key=True)

    # [sync]
    data_source_id: int = Field(foreign_key="data_sources.id", index=True)
    physical_path: str
    physical_name: str
    entity_type: EntityType = Field(default=EntityType.TABLE)
    last_synced_at: datetime | None = None
    is_deprecated: bool = Field(default=False)

    # [curate]
    display_name: str
    description: str | None = None
    synonyms: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    grain_description: str | None = None
    is_exposed: bool = Field(default=False)
    is_pii: bool = Field(default=False)

    # [profile]
    row_count_est: int | None = None
    last_profiled_at: datetime | None = None

    # derived
    embed_text: str | None = None

    data_source: "DataSource" = Relationship(back_populates="entities")
    columns: list["EntityColumn"] = Relationship(back_populates="entity")
