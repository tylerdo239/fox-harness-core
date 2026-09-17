from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel

from src.database.models.enums import DefaultAggregation


class Metric(SQLModel, table=True):
    __tablename__ = "metrics"

    id: int | None = Field(default=None, primary_key=True)

    name: str = Field(index=True)
    description: str | None = None
    synonyms: list[str] = Field(default_factory=list, sa_column=Column(JSON))

    base_entity_id: int = Field(foreign_key="entities.id", index=True)
    aggregation: DefaultAggregation
    measure_column_id: int = Field(foreign_key="entity_columns.id")

    default_filters: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    time_column_id: int | None = Field(default=None, foreign_key="entity_columns.id")
    allowed_dimension_column_ids: list[int] = Field(default_factory=list, sa_column=Column(JSON))

    grain: str | None = None
    unit: str | None = None

    sample_nl_questions: list[str] = Field(default_factory=list, sa_column=Column(JSON))

    canonical_sql: str | None = None
    is_verified: bool = Field(default=False)
