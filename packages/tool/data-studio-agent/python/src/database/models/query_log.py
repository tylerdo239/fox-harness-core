from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel

from src.database.models.enums import QueryLogStatus, UserFeedback


class QueryLog(SQLModel, table=True):
    __tablename__ = "query_log"

    id: int | None = Field(default=None, primary_key=True)

    question: str
    plan_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    generated_sql: str | None = None

    status: QueryLogStatus
    error_text: str | None = None

    row_count: int | None = None
    latency_ms: int | None = None

    user_feedback: UserFeedback | None = None
    feedback_correction: str | None = None

    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
