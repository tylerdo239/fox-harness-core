"""pipeline_v3 — agent-loop rewrite of the text-to-SQL pipeline.

Vertical slice: Intake→Retrieval→Grain→Metric→Slice→Compile→Execute for a single
group-by question, proving the Worker→Parser two-model split + grain back-edge before
the full 12-agent build. See docs/agent-loop-architecture.md.
"""
