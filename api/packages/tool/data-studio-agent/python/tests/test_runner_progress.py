"""Ours: bridge/runner.py reduces pipeline v3/v4 events to the small progress items the UI shows live."""

import importlib.util
import json
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("runner", Path(__file__).resolve().parent.parent / "bridge" / "runner.py")
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)  # type: ignore[union-attr]


def _run(events: list[tuple[str, dict]], capsys: pytest.CaptureFixture[str]) -> list[dict]:
    p = runner._Progress()
    for kind, payload in events:
        p.emit(kind, payload)
    return [json.loads(line)["progress"] for line in capsys.readouterr().out.splitlines()]


def test_v3_agents_and_tools_pair_up(capsys: pytest.CaptureFixture[str]) -> None:
    items = _run([
        ("agent_started", {"agent": "clarify", "label": "Checking clarity", "step_id": "s1"}),
        ("tool_started", {"agent": "clarify", "tool": "pick_display_columns", "args": {"table_name": "workflows"}, "step_id": "s1"}),
        ("tool_done", {"agent": "clarify", "tool": "pick_display_columns", "result": "ok", "step_id": "s1"}),
        ("agent_done", {"agent": "clarify", "ok": True, "step_id": "s1"}),
        ("trace", {"text": "noise"}),
        ("agent_delta", {"delta": "x"}),
        ("result", {"sql": "SELECT 1", "rows": [{"n": 1}], "row_count": 1}),
    ], capsys)
    assert [i["t"] for i in items] == ["agent", "tool", "tool", "agent", "sql"]   # trace / deltas left out
    start, done = items[1], items[2]
    assert start["id"] == done["id"] and start["owner"] == done["owner"] == "s1:clarify"
    assert items[3] == {"t": "agent", "id": "s1:clarify", "agent": "clarify", "status": "done"}
    assert items[4] == {"t": "sql", "sql": "SELECT 1", "rows": 1}


def test_v4_steps_parts_and_failures(capsys: pytest.CaptureFixture[str]) -> None:
    items = _run([
        ("step", {"step": "find", "status": "started", "label": "Finding the data", "part": "q1"}),
        ("decompose", {"parts": [{"id": "q1", "question": "a"}, {"id": "q2", "question": "b"}]}),
        ("agent_done", {"agent": "scout", "run_id": "r1", "ok": False, "error": "x" * 500}),
        ("result", {"status": "failed", "error": "boom", "row_count": 0, "part": "q2"}),
        ("charts", {"charts": [{}]}),
    ], capsys)
    assert items[0] == {"t": "step", "name": "find", "label": "Finding the data", "status": "started", "part": "q1"}
    assert items[1]["parts"] == [{"id": "q1", "question": "a"}, {"id": "q2", "question": "b"}]
    assert items[2]["status"] == "failed" and len(items[2]["error"]) <= 161
    assert items[3] == {"t": "result", "status": "failed", "rows": 0, "error": "boom", "part": "q2"}
    assert len(items) == 4   # charts left out
