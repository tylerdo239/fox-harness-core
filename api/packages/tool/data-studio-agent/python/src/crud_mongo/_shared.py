"""Small helpers shared by every crud_mongo/*.py module."""

from datetime import UTC, datetime
from uuid import uuid4


def new_id() -> str:
    return str(uuid4())


def utcnow() -> datetime:
    return datetime.now(UTC)
