from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


class BusinessProcess(SQLModel, table=True):
    __tablename__ = "business_process"

    id: int | None = Field(default=None, primary_key=True)

    name: str = Field(index=True)
    description: str | None = None

    related_metric_ids: list[int] = Field(default_factory=list, sa_column=Column(JSON))
    related_entity_ids: list[int] = Field(default_factory=list, sa_column=Column(JSON))

    typical_steps: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    sample_questions: list[str] = Field(default_factory=list, sa_column=Column(JSON))
