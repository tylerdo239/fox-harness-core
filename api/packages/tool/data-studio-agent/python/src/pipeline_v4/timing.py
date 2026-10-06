"""How long each part of a run takes.

    @timed("step3.keywords")            on any function, sync or async (async stays async, so
    async def extract_keywords(...):    agno still sees decorated tools as async with their docstring)

    with track() as timings:            collect every @timed call made inside, nested by caller
        await find_profile(...)         (works across await and concurrent tasks)
    with span("worker"): ...            time a block inside a function the same way
    print_timings(timings)              a rich tree in execution order: start offset, seconds,
                                        share of the run

Children are kept in the order they started, so the tree reads as the run happened; the start
offset (+1.20s) shows overlap when steps run concurrently.

Outside `track()` the decorator only logs at DEBUG level, so production code can keep it.
"""

import functools
import inspect
import logging
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, TypeVar

from rich.console import Console
from rich.tree import Tree

log = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])


@dataclass
class Timing:
    name: str
    started: float = field(default_factory=time.perf_counter)  # perf_counter at start
    seconds: float = 0.0
    ok: bool = True
    children: list["Timing"] = field(default_factory=list)


_current: ContextVar[Timing | None] = ContextVar("pipeline_v4_timing", default=None)


@contextmanager
def track(name: str = "run") -> Iterator[Timing]:
    root = Timing(name)
    token = _current.set(root)
    try:
        yield root
    finally:
        root.seconds = time.perf_counter() - root.started
        _current.reset(token)


@contextmanager
def span(name: str) -> Iterator[Timing]:
    node, token = _start(name)
    ok = False
    try:
        yield node
        ok = True
    finally:
        _finish(node, token, node.started, ok)


def _start(name: str) -> tuple[Timing, Any]:
    node = Timing(name)
    parent = _current.get()
    if parent is not None:
        parent.children.append(node)  # appended at start: children stay in execution order
    return node, _current.set(node)


def _finish(node: Timing, token: Any, started: float, ok: bool) -> None:
    node.seconds = time.perf_counter() - started
    node.ok = ok
    _current.reset(token)
    log.debug("%s took %.3fs%s", node.name, node.seconds, "" if ok else " (failed)")


def timed(name: str | None = None) -> Callable[[F], F]:
    def wrap(fn: F) -> F:
        label = name or fn.__qualname__
        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                node, token = _start(label)
                ok = False
                try:
                    result = await fn(*args, **kwargs)
                    ok = True
                    return result
                finally:
                    _finish(node, token, node.started, ok)
            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            node, token = _start(label)
            ok = False
            try:
                result = fn(*args, **kwargs)
                ok = True
                return result
            finally:
                _finish(node, token, node.started, ok)
        return sync_wrapper  # type: ignore[return-value]
    return wrap


def _style(seconds: float) -> str:
    return "bold red" if seconds >= 10 else "yellow" if seconds >= 2 else "green"


def timing_tree(root: Timing) -> Tree:
    total = root.seconds or 1e-9

    def label(t: Timing) -> str:
        offset = f"[dim]+{t.started - root.started:6.2f}s[/dim] " if t is not root else ""
        share = f" [dim]{t.seconds / total:4.0%}[/dim]" if t is not root else ""
        failed = " [red]failed[/red]" if not t.ok else ""
        return f"{offset}[{_style(t.seconds)}]{t.seconds:7.2f}s[/] {t.name}{share}{failed}"

    tree = Tree(label(root))

    def add(branch: Tree, node: Timing) -> None:
        for child in node.children:
            add(branch.add(label(child)), child)

    add(tree, root)
    return tree


def print_timings(root: Timing, console: Console | None = None) -> None:
    (console or Console()).print(timing_tree(root))
