"""Name→id resolution for agent outputs.

Agents refer to schema by NAME (`workflows`, `workflows.workflow_id`), never by numeric id — an
LLM pattern-matches on names, but an integer id carries no signal, so a weak model picks a
plausible-looking wrong number. Names are self-checking. This module maps those names back to the
EntityColumn / Entity ids the templates need, scoped to the retrieval candidates so a name outside
the candidate set is rejected (→ re-plan) rather than silently resolved to some other table.

Collisions (two candidate tables with a column of the same bare name) are handled by requiring the
`table.column` form; a bare column name that is ambiguous returns None so the caller can re-plan.
"""

from __future__ import annotations

from dataclasses import dataclass

from src.services.schema_linking import RetrievalResult


@dataclass
class NameResolver:
    """Built once per question from the retrieval candidates. Resolves entity + column names."""

    entity_by_name: dict[str, int]          # normalized table/display name → entity_id
    column_by_qualified: dict[str, int]     # "table.column" (normalized) → column_id
    column_by_bare: dict[str, list[int]]    # "column" (normalized) → [column_id, …] (for ambiguity)
    entity_name_by_id: dict[int, str]       # entity_id → bare table name (for rendering)

    @classmethod
    def from_retrieval(cls, retrieval: RetrievalResult, session) -> "NameResolver":
        from src.database.models import Entity, EntityColumn

        entity_by_name: dict[str, int] = {}
        column_by_qualified: dict[str, int] = {}
        column_by_bare: dict[str, list[int]] = {}
        entity_name_by_id: dict[int, str] = {}

        for cand in retrieval.entities:
            ent = session.get(Entity, cand.id)
            if ent is None:
                continue
            table = ent.physical_path.split(".")[-1] if ent.physical_path else ent.display_name
            table_key = _norm(table)
            entity_by_name[table_key] = cand.id
            entity_by_name[_norm(ent.display_name or "")] = cand.id
            entity_name_by_id[cand.id] = table

            cols = session.exec(
                _exposed_cols_query(EntityColumn, cand.id)
            ).all()
            for c in cols:
                qual = f"{table_key}.{_norm(c.physical_name)}"
                column_by_qualified[qual] = c.id
                # also index by display name qualified, in case the agent uses that
                column_by_qualified[f"{table_key}.{_norm(c.display_name or '')}"] = c.id
                column_by_bare.setdefault(_norm(c.physical_name), []).append(c.id)

        return cls(entity_by_name, column_by_qualified, column_by_bare, entity_name_by_id)

    def entity(self, name: str) -> int | None:
        return self.entity_by_name.get(_norm(name))

    def column(self, ref: str) -> int | None:
        """Resolve a column reference. Prefers `table.column`; a bare `column` resolves only when
        unambiguous across candidates. Returns None (→ caller re-plans) for unknown/ambiguous."""
        if ref is None:
            return None
        key = _norm_ref(ref)
        if "." in key:
            return self.column_by_qualified.get(key)
        hits = self.column_by_bare.get(key, [])
        return hits[0] if len(hits) == 1 else None


def _exposed_cols_query(EntityColumn, entity_id: int):
    from sqlmodel import select

    return select(EntityColumn).where(
        EntityColumn.entity_id == entity_id,
        EntityColumn.is_exposed == True,  # noqa: E712
        EntityColumn.is_deprecated == False,  # noqa: E712
    )


def _norm(s: str) -> str:
    """Lowercase, strip spaces/quotes. Keeps '.' for qualified refs handled separately."""
    return (s or "").strip().strip('"').strip("`").lower()


def _norm_ref(ref: str) -> str:
    """Normalize a possibly-qualified ref. Drops a leading schema/db prefix, keeps last table.column
    (so 'workflows_db.workflows.workflow_id' → 'workflows.workflow_id')."""
    parts = [p for p in _norm(ref).split(".") if p]
    if len(parts) >= 2:
        return f"{parts[-2]}.{parts[-1]}"
    return parts[0] if parts else ""
