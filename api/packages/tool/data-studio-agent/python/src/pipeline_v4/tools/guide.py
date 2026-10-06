"""Guiding errors: every failed tool call tells the agent what to do next.

An error reads  `error: <what is wrong> (nothing changed). Next: <one concrete step>`. The next step
is a call the agent can make, with its arguments filled from what it sent (`Run
search_profile(text='…', kind='column')`), or a plain instruction (`use one of: …`, `call done`).
A step naming a tool the agent does not have is dropped, so an agent is never told to run a tool it
can't call; the first call left and the first plain instruction are shown, in the order given.

The same call failing the same way again gets a warning to change approach instead of retrying.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Self

from agno.tools import Toolkit

MAX_OPTIONS = 12   # longer option lists are cut ("… N more")


@dataclass(frozen=True)
class Run:
    """A call to suggest: Run tool(arg=value, …)."""
    tool: str
    args: tuple[tuple[str, Any], ...] = ()

    @classmethod
    def of(cls, tool: str, **args: Any) -> "Run":
        return cls(tool, tuple((k, v) for k, v in args.items() if v is not None))

    def text(self) -> str:
        return f"Run {self.tool}({', '.join(f'{k}={v!r}' for k, v in self.args)})"


Step = Run | str   # a call, or a plain instruction


class Problem(str):
    """A problem text that carries its next steps (falsy "" means no problem)."""
    steps: tuple[Step, ...]

    def __new__(cls, text: str, *steps: Step) -> Self:
        obj = super().__new__(cls, text)
        obj.steps = steps
        return obj


def steps_of(problem: str) -> tuple[Step, ...]:
    return getattr(problem, "steps", ())


def lookup_steps(kind: str, name: str) -> list[Step]:
    """How to find the right name of a `kind` (table, column, metric, term) the agent got wrong."""
    words = " ".join(name.replace(".", " ").replace("_", " ").split())
    table = name.split(".")[0] if kind == "column" and "." in name else None
    found = {
        "table": [Run.of("search_profile", text=words, kind="table")],
        "column": [*([Run.of("describe_table", table=table)] if table else []),
                   Run.of("search_profile", text=words, kind="column")],
        "metric": [Run.of("search_profile", text=words, kind="metric")],
        "term": [Run.of("search_term", pattern=words), Run.of("search_profile", text=words, kind="term")],
    }.get(kind, [Run.of("search_profile", text=words)])
    return [*found, f"use a {kind} name exactly as written in the context (copy it, never build one)"]


def options(items: Iterable[str], limit: int = MAX_OPTIONS) -> str:
    """A list of choices for an error message, cut after `limit`."""
    xs = list(dict.fromkeys(items))
    more = f" … {len(xs) - limit} more" if len(xs) > limit else ""
    return ", ".join(xs[:limit]) + more


def tool_names(toolkits: Iterable[Toolkit]) -> set[str]:
    """The tools an agent can call (respecting include_tools / exclude_tools)."""
    out: set[str] = set()
    for tk in toolkits:
        for t in tk.tools:
            name = tk._get_tool_name(t)
            if (tk.include_tools and name not in tk.include_tools) or (tk.exclude_tools and name in tk.exclude_tools):
                continue
            out.add(name)
    return out


def next_step(steps: Iterable[Step], available: set[str] | None) -> str:
    """What to do next: the first call the agent can make and the first plain instruction, in the order
    given (calls naming a tool the agent lacks are dropped; all calls count when `available` is unknown)."""
    given = list(steps)
    call = next((x for x in given if isinstance(x, Run) and (available is None or x.tool in available)), None)
    plain = next((x for x in given if isinstance(x, str)), None)
    return " — or ".join(x if isinstance(x, str) else x.text() for x in given if x is call or x is plain)


def render(problem: str, steps: Iterable[Step], available: set[str] | None) -> str:
    step = next_step(steps, available)
    problem = problem.rstrip(". ")
    return f"{problem} (nothing changed). Next: {step}" if step else f"{problem} (nothing changed)"


REPEATED = ("you already made this exact call and got this same error; do not retry it. Change the "
            "arguments as the error says, use another tool, or call done if your answer is complete")
