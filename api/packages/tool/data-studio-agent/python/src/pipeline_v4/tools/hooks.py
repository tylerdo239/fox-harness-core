"""An agno tool hook that records every tool call of the agent run in progress (for the trace)."""

from collections.abc import Callable
from contextvars import ContextVar
from inspect import isawaitable
from typing import Any

# the tool calls of the agent run in progress (each run sets its own list)
tool_log: ContextVar[list[dict[str, Any]] | None] = ContextVar("pipeline_v4_tool_log", default=None)


async def record_tool_call(function_name: str, function_call: Callable[..., Any], arguments: dict[str, Any]) -> Any:
    entry: dict[str, Any] = {"tool": function_name, "args": dict(arguments)}
    log = tool_log.get()
    if log is not None:
        log.append(entry)
    result = function_call(**arguments)
    if isawaitable(result):
        result = await result
    entry["result"] = str(result)
    return result
