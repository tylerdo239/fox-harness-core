"""Small helpers shared by every crud_mongo/*.py module."""

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


def new_id() -> str:
    return str(uuid4())


def utcnow() -> datetime:
    return datetime.now(UTC)


def set_disabled(db: Any, collection: str, doc_id: str, disabled: bool) -> bool:
    """Turn an item off for the agents (disabled_at = now) or back on (None); False when it does not exist.
    A disabled item stays visible and editable in the profile; the pipeline's catalog leaves it out."""
    res = db[collection].update_one({"_id": doc_id, "deleted_at": None},
                                    {"$set": {"disabled_at": utcnow() if disabled else None, "updated_at": utcnow()}})
    return res.matched_count > 0
