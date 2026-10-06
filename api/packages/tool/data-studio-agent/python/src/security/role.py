"""Role-based data access for the analyze_data pipeline (two roles: admin, user).

Dremio is OSS (no row/column policies), so who may see what is decided HERE, in code, before a query
reaches Dremio. The role of the conversation's owner arrives with each question from the Node side
(packages/tool/data-studio-agent: the gateway -> runtime -> tool path; never from the model) and is held
in a ContextVar for the duration of that one question, so every catalog read below it is filtered
without threading a parameter through ~15 call sites.

Rules:
  admin -> everything the catalog already exposes (`is_exposed`, not deprecated — unchanged behaviour).
  user  -> only entities/columns whose `allowed_roles` contains "user" AND that are not `is_pii`; a column
           additionally needs its entity to be visible. A missing `allowed_roles` means admin-only, so a
           newly synced table is never visible to users until an admin opts it in.

The default role is "user" (least privilege): any code path that forgets to set a role gets the
narrowest view, never the widest. Admin-only tooling (bridge/admin_runner.py) sets "admin" explicitly.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

ADMIN = "admin"
USER = "user"
ROLES = (ADMIN, USER)

_current: ContextVar[str] = ContextVar("fox_data_role", default=USER)
# Data sources an admin switched off for the agents (disabled_at) or deleted (deleted_at): while ANSWERING a
# question their tables are out of the catalog for every role. Empty outside a question, so admin jobs (sync,
# profiling, the profile editor) still see everything. Set once per question by begin_question().
_hidden_sources: ContextVar[frozenset[str]] = ContextVar("fox_hidden_sources", default=frozenset())


def current() -> str:
    return _current.get()


def is_admin() -> bool:
    return _current.get() == ADMIN


def begin_question(db: Any, role: str) -> None:
    """Start answering one question (bridge/runner.py): the caller's role, and which data sources are off."""
    set_role(role)
    hidden = {d["_id"] for d in db["data_sources"].find(
        {"$or": [{"disabled_at": {"$ne": None}}, {"deleted_at": {"$ne": None}}]}, {"_id": 1})}
    _hidden_sources.set(frozenset(hidden))


def hidden_sources() -> frozenset[str]:
    return _hidden_sources.get()


def unrestricted() -> bool:
    """Nothing to filter at all: an admin, and no data source switched off for this question."""
    return is_admin() and not _hidden_sources.get()


def set_role(role: str) -> None:
    """Set the role for the rest of the current context (one question in bridge/runner.py)."""
    _current.set(role if role in ROLES else USER)


@contextmanager
def as_role(role: str) -> Iterator[None]:
    """Run a block under `role` — used by the SQL validator to read the FULL catalog (as admin) and then
    judge it against the caller's real role. Never use it to widen what a caller can retrieve."""
    token = _current.set(role if role in ROLES else USER)
    try:
        yield
    finally:
        _current.reset(token)


def catalog_filter() -> dict[str, Any]:
    """Mongo filter fragment for entities / entity_columns visible to the current role."""
    if is_admin():
        return {}
    return {"allowed_roles": USER, "is_pii": {"$ne": True}}


def entity_filter() -> dict[str, Any]:
    """Mongo filter fragment for ENTITIES: the role filter, plus tables of switched-off sources while answering."""
    hidden = _hidden_sources.get()
    return {**catalog_filter(), **({"data_source_id": {"$nin": sorted(hidden)}} if hidden else {})}


def doc_allowed(doc: dict[str, Any] | None, role: str | None = None) -> bool:
    """Whether one entity/column document is visible to `role` (default: the current role)."""
    if doc is None:
        return False
    if doc.get("data_source_id") in _hidden_sources.get():  # an entity of a switched-off source
        return False
    if (role or _current.get()) == ADMIN:
        return True
    return USER in (doc.get("allowed_roles") or []) and not doc.get("is_pii")


def visible_entity_ids(db: Any) -> set[str] | None:
    """Ids of entities the current role may see; None means "no restriction" (admin, no source switched off)."""
    if unrestricted():
        return None
    return {e["_id"] for e in db["entities"].find(entity_filter(), {"_id": 1})}


def visible_column_ids(db: Any, column_ids: list[str]) -> set[str] | None:
    """Which of `column_ids` the current role may see (column AND its entity visible); None = unrestricted."""
    if unrestricted():
        return None
    ids = [c for c in column_ids if c]
    if not ids:
        return set()
    entities = visible_entity_ids(db) or set()
    return {
        c["_id"]
        for c in db["entity_columns"].find({"_id": {"$in": ids}, **catalog_filter()}, {"_id": 1, "entity_id": 1})
        if c.get("entity_id") in entities
    }
