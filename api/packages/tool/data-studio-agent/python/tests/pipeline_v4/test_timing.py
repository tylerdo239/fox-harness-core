import asyncio
import inspect

import pytest
from rich.console import Console

from src.pipeline_v4.context import Names
from src.pipeline_v4.timing import Timing, print_timings, span, timed, track
from src.pipeline_v4.tools.profile import ProfileTools
from tests.pipeline_v4.catalog_fixture import build_catalog


@timed("sync step")
def sync_step(x: int) -> int:
    return x + 1


@timed("async step")
async def async_step() -> int:
    await asyncio.sleep(0.01)
    return await asyncio.to_thread(sync_step, 1)  # a thread keeps the caller as parent


@timed("fails")
def failing() -> None:
    raise ValueError("boom")


def names(t: Timing) -> list:
    return [t.name, [names(c) for c in t.children]] if t.children else [t.name]


def test_tree_follows_execution_order_and_nesting() -> None:
    async def run() -> Timing:
        with track() as root:
            sync_step(0)
            await async_step()
            with span("block"):
                sync_step(2)
        return root

    root = asyncio.run(run())
    assert names(root) == ["run", [["sync step"], ["async step", [["sync step"]]], ["block", [["sync step"]]]]]
    starts = [c.started for c in root.children]
    assert starts == sorted(starts)
    assert root.children[1].seconds >= 0.01


def test_concurrent_steps_keep_their_start_order() -> None:
    @timed("slow")
    async def slow() -> None:
        await asyncio.sleep(0.03)

    @timed("fast")
    async def fast() -> None:
        await asyncio.sleep(0.001)

    async def run() -> Timing:
        with track() as root:
            await asyncio.gather(slow(), fast())
        return root

    root = asyncio.run(run())
    assert [c.name for c in root.children] == ["slow", "fast"]   # started first, finished last
    assert root.children[0].seconds > root.children[1].seconds


def test_failures_are_marked_and_still_raise() -> None:
    with track() as root, pytest.raises(ValueError):
        failing()
    assert root.children[0].ok is False


def test_decorated_tools_stay_async_with_their_docstrings() -> None:
    cat = build_catalog()
    kit = ProfileTools(cat, Names(cat), None)
    for tool in (kit.search_profile, kit.describe_table, kit.list_values, kit.join_path):
        assert inspect.iscoroutinefunction(tool)
        assert "Args:" in (tool.__doc__ or "")
        assert list(inspect.signature(tool).parameters)[0] in ("text", "table", "column", "from_table")


def test_without_track_nothing_is_collected() -> None:
    assert sync_step(1) == 2


def test_rich_tree_prints_offsets_and_failures() -> None:
    with track("demo") as root:
        sync_step(0)
        with pytest.raises(ValueError):
            failing()
    console = Console(record=True, width=100)
    print_timings(root, console)
    text = console.export_text()
    assert "demo" in text and "sync step" in text and "fails" in text and "failed" in text
    assert "+  0.00s" in text


def test_every_pipeline_step_is_async() -> None:
    from src.pipeline_v4.agents.base import StructuredAgent, TextAgent, ToolAgent
    from src.pipeline_v4.agents.keywords import extract_keywords
    from src.pipeline_v4.agents.retrieval import apply_selection
    from src.pipeline_v4.catalog import load_catalog
    from src.pipeline_v4.compiler import compile_spec
    from src.pipeline_v4.context import build_context
    from src.pipeline_v4.dremio import AsyncDremio
    from src.pipeline_v4.find import find_profile
    from src.pipeline_v4.present import present
    from src.pipeline_v4.retrieve import MeiliProfileSearch, retrieve
    from src.pipeline_v4.run import run_query

    steps = [present, TextAgent.run, run_query, AsyncDremio.explain, AsyncDremio.run, load_catalog, extract_keywords, retrieve, MeiliProfileSearch.search, build_context, apply_selection,
             find_profile, compile_spec, StructuredAgent.run, ToolAgent.run]
    assert [s.__qualname__ for s in steps if not inspect.iscoroutinefunction(s)] == []


def test_the_tool_hook_records_each_call_of_the_running_agent() -> None:
    from src.pipeline_v4.tools.hooks import record_tool_call, tool_log

    cat = build_catalog()
    h = Names(cat)
    kit = ProfileTools(cat, h, None, include_tools=["describe_table"])
    assert list(kit.get_async_functions()) == ["describe_table"]           # include_tools trims the toolkit
    describe = kit.get_async_functions()["describe_table"].entrypoint

    async def run() -> list:
        calls: list = []
        token = tool_log.set(calls)
        try:
            await record_tool_call("describe_table", describe, {"table": "orders"})
        finally:
            tool_log.reset(token)
        return calls

    calls = asyncio.run(run())
    assert calls[0]["tool"] == "describe_table" and calls[0]["args"] == {"table": "orders"}
    assert calls[0]["result"].startswith("orders —")
