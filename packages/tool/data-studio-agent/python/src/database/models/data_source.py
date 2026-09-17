from datetime import datetime
from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

from src.database.models.enums import SourceStatus

if TYPE_CHECKING:
    from src.database.models.entity import Entity


class DataSource(SQLModel, table=True):
    __tablename__ = "data_sources"

    id: int | None = Field(default=None, primary_key=True)

    # [sync]
    name: str = Field(index=True)
    source_type: str
    dremio_path: str
    status: SourceStatus = Field(default=SourceStatus.DISCONNECTED)
    last_synced_at: datetime | None = None

    # [curate]
    is_exposed_to_agent: bool = Field(default=False)

    entities: list["Entity"] = Relationship(back_populates="data_source")
