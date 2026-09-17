from datetime import UTC, datetime

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel

from src.database.models.enums import VerifiedQuerySource


class VerifiedQuery(SQLModel, table=True):
    __tablename__ = "verified_queries"

    id: int | None = Field(default=None, primary_key=True)

    nl_question: str
    sql: str

    entities_used: list[int] = Field(default_factory=list, sa_column=Column(JSON))
    columns_used: list[int] = Field(default_factory=list, sa_column=Column(JSON))

    is_verified: bool = Field(default=False)
    source: VerifiedQuerySource = Field(default=VerifiedQuerySource.HUMAN)

    embed_text: str | None = None

    created_by: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
