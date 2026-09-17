"""pipeline_v2 — slot-filling text-to-SQL pipeline.

A single accumulating state ticket ('phiếu') is filled across steps 0→8. LLM only where
language understanding is required (steps 0,1,3,4,5); grounding, join-strategy classification,
edge-case defaults, and SQL assembly are deterministic. Reuses v1's retrieval, grounding,
validation, and execution services untouched — only the orchestration and the new
join-strategy / grain / select-ladder logic live here.

Entry point: run_pipeline_v2 (orchestrator.py), contract-compatible with v1's run_pipeline.
"""

from src.pipeline_v2.orchestrator import run_pipeline_v2, run_pipeline_v2_decomposed

__all__ = ["run_pipeline_v2", "run_pipeline_v2_decomposed"]
