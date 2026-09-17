"""Worker→Parser two-model split — the core of pipeline_v3.

The local model cannot do tool-calling and structured output (output_schema) in the same
call — they are mutually exclusive modes. So every agent is TWO model roles:

    Worker  : tools ON, emits free markdown  (the reasoning + the trace)
    Parser  : no tools, output_schema ON     (turns that markdown into typed JSON)

The Worker's markdown is what the Parser reads AND what we append to the run's trace.
The Parser's typed JSON is the ONLY thing that flows to the next agent — a weak model
never parses another agent's prose, which keeps the plan from being corrupted by loose
markdown (the grain-variance class of bug re-entering through the seams).

Agno's built-in `parser_model` implements exactly this: it strips the Worker's final
message and feeds the markdown to the parser model as its user message. We wrap that here
so every agent gets: hard tool caps, a parse-fail guard (parser output can silently fall
back to a str), and a uniform (typed_result, markdown) return.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

from agno.agent import Agent, RunEvent
from agno.models.openai.like import OpenAILike
from agno.tools import Function
from pydantic import BaseModel

SchemaT = TypeVar("SchemaT", bound=BaseModel)

# on_event(event_type, payload) — the pipeline's streaming sink (SSE). None disables streaming.
EventSink = Callable[[str, dict], Awaitable[None]]


@dataclass
class AgentRun:
    """One agent's output: the typed contract (→ next agent) + markdown (→ trace)."""

    result: BaseModel | None       # parsed output_schema instance, or None if parse failed
    markdown: str                  # the Worker's markdown (always kept, even on parse fail)
    ok: bool                       # True iff result is a valid schema instance
    error: str | None = None


class WorkerParserAgent:
    """A single specialist agent: a tool-using Worker paired with a no-tools Parser.

    Reused across all 12 agents — only the tool set, schema, and prompts differ.
    """

    def __init__(
        self,
        *,
        name: str,
        model: OpenAILike,
        tools: list[Function],
        output_schema: type[BaseModel],
        worker_instructions: str | list[str],
        parser_rules: str,
        tool_call_limit: int = 6,
    ) -> None:
        self.name = name
        self._output_schema = output_schema
        # A hard global frame prepended to every worker. The weak model tends to drift into a
        # chat-assistant persona ("I can't access your database…") and to deliberate in circles;
        # this keeps every worker a terse, single-purpose pipeline step. Bold markers get more of
        # the model's attention, so the non-negotiables are bolded.
        instrs = worker_instructions if isinstance(worker_instructions, list) else [worker_instructions]
        framed = [
            "**You are ONE step of a text-to-SQL pipeline, not a chatbot.** The data is in OUR "
            "database and later steps run the SQL — **never say you cannot access the data, never "
            "ask the user to run SQL, never mention external platforms.**",
            "**Do only your step's task. Be terse and decisive — one pass, no back-and-forth "
            "deliberation, no restating the question.** Then your task:",
            *instrs,
        ]
        # Worker: tools ON, NO output_schema (weak model can't do both). Emits markdown.
        self._worker = Agent(
            name=f"{name}.worker",
            model=model,
            tools=tools,
            tool_call_limit=tool_call_limit,
            instructions=framed,
            debug_mode=False,
        )
        # Parser: NO tools, output_schema ON. Reads the Worker's markdown → typed JSON.
        # use_json_mode=True: force JSON for a local model that lacks native schema output.
        self._parser = Agent(
            name=f"{name}.parser",
            model=model,
            output_schema=output_schema,
            use_json_mode=True,
            instructions=parser_rules,
            debug_mode=False,
        )

    async def run(self, prompt: str, on_event: EventSink | None = None) -> AgentRun:
        # 1. Worker loops over tools, produces markdown. Stream its tool calls + content deltas to
        #    the UI when an on_event sink is given, so the user sees the AI working in real time.
        if on_event is None:
            worker_run = await self._worker.arun(prompt)
            markdown = _as_text(worker_run.content)
        else:
            markdown = await self._run_worker_streaming(prompt, on_event)

        # 2. Parser turns that markdown into a typed struct. Retry once on parse miss.
        result, err = await self._parse(markdown)
        if result is None:
            result, err = await self._parse(
                markdown,
                extra="Your previous output did not match the schema. "
                "Return ONLY valid JSON for the schema, nothing else.",
            )

        return AgentRun(
            result=result,
            markdown=markdown,
            ok=result is not None,
            error=err,
        )

    async def _run_worker_streaming(self, prompt: str, on_event: EventSink) -> str:
        """Run the Worker with streaming, forwarding tool calls + markdown deltas as SSE events.
        Returns the assembled markdown (same value the non-streaming path returns)."""
        parts: list[str] = []
        async for ev in self._worker.arun(prompt, stream=True, stream_events=True):
            etype = getattr(ev, "event", None)
            if etype == RunEvent.tool_call_started and getattr(ev, "tool", None):
                await on_event("tool_started", {
                    "agent": self.name,
                    "tool": ev.tool.tool_name,
                    "args": ev.tool.tool_args or {},
                })
            elif etype == RunEvent.tool_call_completed and getattr(ev, "tool", None):
                await on_event("tool_done", {
                    "agent": self.name,
                    "tool": ev.tool.tool_name,
                    "result": _truncate(str(ev.tool.result or "")),
                })
            elif etype == RunEvent.run_content:
                delta = getattr(ev, "content", None)
                if delta:
                    parts.append(delta)
                    await on_event("agent_delta", {"agent": self.name, "delta": delta})
        return "".join(parts)

    async def _parse(self, markdown: str, extra: str = "") -> tuple[BaseModel | None, str | None]:
        prompt = markdown if not extra else f"{markdown}\n\n{extra}"
        run = await self._parser.arun(prompt)
        content = run.content
        # Guard (Agno docs): "Fallback parsing failures ... can leave response.content as a
        # string." Never pass a str where the next agent expects a struct.
        if isinstance(content, self._output_schema):
            return content, None
        return None, f"parser returned {type(content).__name__}, expected {self._output_schema.__name__}"


def _truncate(s: str, n: int = 200) -> str:
    return s if len(s) <= n else s[:n] + "…"


def _as_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, BaseModel):
        return content.model_dump_json(indent=2)
    return str(content)
