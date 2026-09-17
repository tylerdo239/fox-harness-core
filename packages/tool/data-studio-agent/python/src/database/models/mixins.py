from datetime import UTC, datetime

from sqlmodel import Field


class TimestampMixin:
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
