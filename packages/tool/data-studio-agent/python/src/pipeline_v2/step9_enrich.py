"""Display-column derivation for the enrichment stage.

pipeline_v2 has no stored display_columns (that was v1's build_display_columns), so this maps each
result field to {physical_name, display_name, semantic_type, role}: SELECT columns resolve to
their curated column record; metric aliases are synthesized as measure/count columns (they have
no EntityColumn row). Charts and insights use this to tell dimensions from measures.

The actual enrichment (charts + streamed markdown insights + follow-ups) is orchestrated in the
orchestrator's _enrich_streaming, which streams token deltas to the UI — see orchestrator.py.
"""

from typing import Any

from sqlmodel import Session

from src.database.models import EntityColumn
from src.pipeline_v2.state import PipelineState


def _build_display_columns(session: Session, state: PipelineState) -> list[dict[str, Any]]:
    cols: list[dict[str, Any]] = []
    for cid in state.select_column_ids:
        c = session.get(EntityColumn, cid)
        if c is None:
            continue
        cols.append({
            "physical_name": c.physical_name,
            "display_name": c.display_name,
            "semantic_type": c.semantic_type.value if c.semantic_type else None,
            "role": c.role.value if c.role else None,
        })
    for m in state.metrics:
        cols.append({
            "physical_name": m.alias,
            "display_name": m.alias,
            "semantic_type": "count" if m.expr_column_id is None else None,
            "role": "measure",
        })
    return cols
