"""Step 7 — Edge cases + output (rule / default, no LLM).

Applies safe defaults and records them as assumptions rather than asking the user:
  - soft delete: if the grain entity has an is_deleted / deleted_at column, exclude deleted rows
  - order/limit: taken from step-0 output_hints (ranking direction, top-N)
  - dedup note: flagged when counting a many-side that might have versioned/duplicate rows

The design doc's rule: apply a safe default + write it to `assumptions`; only clarify when a
default could materially skew the number. Nothing here changes the SELECT/GROUP BY.
"""

from sqlmodel import Session

from src.database.models import Entity
from src.pipeline_v2 import derive
from src.pipeline_v2.state import PipelineState

# columns that, by convention, mark a soft-deleted row
_SOFT_DELETE_FLAGS = ("is_deleted", "deleted", "is_removed")
_SOFT_DELETE_TIMESTAMPS = ("deleted_at", "removed_at")


def run_step7(session: Session, state: PipelineState) -> None:
    _apply_soft_delete(session, state)
    _apply_output(state)


def _apply_soft_delete(session: Session, state: PipelineState) -> None:
    seen_entities = set(state.target_entity_ids)
    for eid in seen_entities:
        entity = session.get(Entity, eid)
        if entity is None:
            continue
        for c in derive.exposed_columns(session, eid):
            name = c.physical_name.lower()
            table = entity.physical_path.split(".")[-1]
            if name in _SOFT_DELETE_FLAGS:
                cond = f'{table}."{c.physical_name}" = FALSE'
                state.edge_cases.soft_delete_conditions.append(cond)
                state.add_assumption(f"Excluded soft-deleted rows via {c.physical_name} = FALSE on {table}.")
            elif name in _SOFT_DELETE_TIMESTAMPS:
                cond = f'{table}."{c.physical_name}" IS NULL'
                state.edge_cases.soft_delete_conditions.append(cond)
                state.add_assumption(f"Excluded soft-deleted rows via {c.physical_name} IS NULL on {table}.")


def _apply_output(state: PipelineState) -> None:
    hints = state.output_hints
    if hints.ranking and state.metrics:
        # order by the (first) metric alias, direction from the hint
        alias = state.metrics[0].alias
        direction = (hints.direction or "desc").upper()
        state.edge_cases.order_by = f"{alias} {direction}"
        state.edge_cases.limit = hints.limit or 1
    elif hints.limit:
        state.edge_cases.limit = hints.limit
