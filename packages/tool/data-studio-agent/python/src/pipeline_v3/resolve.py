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

    entity_by_name: dict[str, str]          # normalized table/display name → entity_id
    column_by_qualified: dict[str, str]     # "table.column" (normalized) → column_id
    column_by_bare: dict[str, list[str]]    # "column" (normalized) → [column_id, …] (for ambiguity)
    entity_name_by_id: dict[str, str]       # entity_id → bare table name (for rendering)

    @classmethod
    def from_retrieval(cls, retrieval: RetrievalResult, db) -> "NameResolver":
        from src.crud_mongo import entity as entity_crud
        from src.crud_mongo import entity_column as entity_column_crud

        entity_by_name: dict[str, str] = {}
        column_by_qualified: dict[str, str] = {}
        column_by_bare: dict[str, list[str]] = {}
        entity_name_by_id: dict[str, str] = {}

        for cand in retrieval.entities:
            ent = entity_crud.get_by_id(db, cand.id)
            if ent is None:
                continue
            table = ent.physical_path.split(".")[-1] if ent.physical_path else ent.display_name
            table_key = _norm(table)
            entity_by_name[table_key] = cand.id
            entity_by_name[_norm(ent.display_name or "")] = cand.id
            entity_name_by_id[cand.id] = table

            cols = entity_column_crud.list_exposed_by_entity(db, cand.id)
            for c in cols:
                qual = f"{table_key}.{_norm(c.physical_name)}"
                column_by_qualified[qual] = c.id
                # also index by display name qualified, in case the agent uses that
                column_by_qualified[f"{table_key}.{_norm(c.display_name or '')}"] = c.id
                column_by_bare.setdefault(_norm(c.physical_name), []).append(c.id)

        return cls(entity_by_name, column_by_qualified, column_by_bare, entity_name_by_id)

    def entity(self, name: str) -> str | None:
        return self.entity_by_name.get(_norm(name))

    def column(self, ref: str) -> str | None:
        """Resolve a column reference. Prefers `table.column`; a bare `column` resolves only when
        unambiguous across candidates. Returns None (→ caller re-plans) for unknown/ambiguous."""
        if ref is None:
            return None
        key = _norm_ref(ref)
        if "." in key:
            return self.column_by_qualified.get(key)
        hits = self.column_by_bare.get(key, [])
        return hits[0] if len(hits) == 1 else None


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
