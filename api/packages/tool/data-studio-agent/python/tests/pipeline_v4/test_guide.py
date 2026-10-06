"""Guiding errors (tools/guide.py): every failed edit-tool call says what to do next, only with tools
the agent has, and a repeated failure is called out."""

import ast
from pathlib import Path

from agno.tools import Toolkit
from pydantic import BaseModel

from src.pipeline_v4.agents.base import Draft
from src.pipeline_v4.tools.guide import Problem, Run, next_step, render, tool_names

TOOLS = Path(__file__).parents[2] / "src" / "pipeline_v4" / "tools"


class _Out(BaseModel):
    items: list[str] = []


def test_every_edit_tool_error_gives_a_next_step() -> None:
    """`self.error(...)` takes next steps, or a `problem` from a shared check (a Problem carries its own)."""
    missing = []
    for path in TOOLS.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "error"
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == "self"):
                first = node.args[0] if node.args else None
                from_check = ((isinstance(first, ast.Name) and first.id == "problem")
                              or (isinstance(first, ast.Attribute) and first.attr == "problem"))
                if len(node.args) < 2 and not from_check:
                    missing.append(f"{path.name}:{node.lineno}")
    assert missing == [], f"errors without a next step: {missing}"


def test_only_tools_the_agent_has_are_suggested() -> None:
    steps = [Run.of("search_term", pattern="x"), Run.of("search_profile", text="x", kind="term"), "copy a listed name"]
    assert next_step(steps, {"search_profile"}) == "Run search_profile(text='x', kind='term') — or copy a listed name"
    assert next_step(steps, set()) == "copy a listed name"
    assert render("bad name.", Problem("x").steps, set()) == "bad name (nothing changed)"


def test_tool_names_respect_include_tools() -> None:
    async def a() -> str:
        return ""

    async def b() -> str:
        return ""

    assert tool_names([Toolkit(name="t", tools=[a, b], include_tools=["a"])]) == {"a"}


def test_the_same_error_twice_is_called_out() -> None:
    d: Draft[_Out] = Draft(_Out())
    first = d.error("x is wrong", ["send y"])
    assert "Next: send y" in first and "already made this exact call" not in first
    assert "already made this exact call" in d.error("x is wrong", ["send y"])
    d.ok("fine")
    assert "already made this exact call" not in d.error("x is wrong", ["send y"])
