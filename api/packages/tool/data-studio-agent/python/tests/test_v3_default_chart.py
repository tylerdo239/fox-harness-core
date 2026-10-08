"""Ours: pipeline v3's fallback bar (when the chart agent proposes nothing usable) never persists a bar with no
series — that rendered as an empty plot (seen with columns `created_at`, `workflows_workflow_id`)."""

from src.pipeline_v3.orchestrator import _default_charts


def test_no_measure_column_gives_no_chart() -> None:
    rows = [{"created_at": "2026-02-09 11:34:20.000", "workflows_workflow_id": 1}]
    assert _default_charts(["created_at", "workflows_workflow_id"], rows, "q") == []


def test_a_measure_column_gives_a_bar() -> None:
    rows = [{"status": "active", "workflow_count": 77}]
    [bar] = _default_charts(["status", "workflow_count"], rows, "q")
    assert (bar["type"], bar["x"], bar["y"], bar["recommended"]) == ("bar", "status", ["workflow_count"], True)
