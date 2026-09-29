"""pipeline_v2 — only state.py, step6_joins.py, step8_generate.py, and templates.py survive.

pipeline_v3 (the only pipeline generation this codebase keeps) reuses pipeline_v2's deterministic
join-planning (step6_joins.py) and SQL-generation/execution glue (step8_generate.py, templates.py)
and its state dataclasses (state.py). Every other pipeline_v2 module (the step0-9 LLM orchestration,
decomposition, enrichment) was deleted with pipeline_v2's own entry point in Plan 2d — see
docs/superpowers/specs/2026-09-17-mysql-to-pymongo-design.md.
"""
