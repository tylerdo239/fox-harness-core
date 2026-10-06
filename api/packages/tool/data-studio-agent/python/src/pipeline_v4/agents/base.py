"""agno agents of pipeline v4.

StructuredAgent    no tools, answers with a Pydantic model (native JSON-schema output); one retry
TextAgent          writes prose for the user (the answer), streamed piece by piece
ToolAgent          builds its answer (a Pydantic model) only through an edit toolkit whose async tools
                   check each change and return the current answer as JSON; a read toolkit looks
                   things up (toolkits: pipeline_v4/tools). No parser model, so nothing rewrites what
                   the agent decided.
"""

import json
import logging
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from agno.agent import Agent, RunEvent
from agno.models.openai.like import OpenAILike
from agno.tools import Toolkit
from pydantic import BaseModel

from src.pipeline_v4.timing import span
from src.pipeline_v4.tools.guide import REPEATED, Step, render, tool_names
from src.pipeline_v4.tools.hooks import record_tool_call, tool_log
from src.settings import Settings

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# on_event(kind, data): the pipeline's live event sink (SSE in the API, the console in test.py)
EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]


def new_run_id() -> str:
    """Every agent run gets an id; all its events carry it, so parallel agents can be told apart."""
    return uuid.uuid4().hex[:10]

_FRAME = (
    "You are one step of a data question-answering pipeline, not a chatbot. "
    "Do only the task below and answer with the JSON object it asks for."
)


class AgentFailed(RuntimeError):
    """The model gave no valid answer, even after one retry."""


@dataclass(frozen=True)
class Sampling:
    """Qwen's recommended sampling for non-thinking (instruct) mode. Greedy decoding
    (temperature 0) makes the model repeat itself endlessly, so it is never used."""

    temperature: float
    top_p: float
    presence_penalty: float
    top_k: int = 20            # vLLM extras, sent in extra_body
    min_p: float = 0.0
    repetition_penalty: float = 1.0


REASONING = Sampling(temperature=1.0, top_p=0.95, presence_penalty=1.5)  # tool agents: think, then edit
GENERAL = Sampling(temperature=0.7, top_p=0.8, presence_penalty=1.5)     # keyword agent: extract phrases
COMPRESSION = Sampling(temperature=0.7, top_p=0.8, presence_penalty=0.0)  # copies names and codes exactly


def make_model(settings: Settings, sampling: Sampling) -> OpenAILike:
    if not settings.openai_model_id:
        raise AgentFailed("no chat model configured (OPENAI_MODEL_ID)")
    # Ours: without a base URL the OpenAI SDK silently targets api.openai.com — never allowed here
    if not settings.openai_base_url:
        raise AgentFailed("OPENAI_BASE_URL is not set; refusing to fall back to api.openai.com")
    extra = {**(settings.openai_extra_body or {}), "top_k": sampling.top_k, "min_p": sampling.min_p,
             "repetition_penalty": sampling.repetition_penalty}
    return OpenAILike(
        id=settings.openai_model_id,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        temperature=sampling.temperature,
        top_p=sampling.top_p,
        presence_penalty=sampling.presence_penalty,
        extra_body=extra,
    )


class StructuredAgent(Generic[T]):
    def __init__(self, name: str, model: OpenAILike, output_schema: type[T], instructions: list[str]) -> None:
        self.name = name
        self.output_schema = output_schema
        self._agent = Agent(
            name=name,
            model=model,
            instructions=[_FRAME, *instructions],
            output_schema=output_schema,
            markdown=False,
            telemetry=False,
        )

    async def run(self, prompt: str, on_event: EventSink | None = None) -> T:
        run_id = new_run_id()
        if on_event:
            await on_event("agent_started", {"agent": self.name, "run_id": run_id, "type": "structured"})
        with span(f"agent {self.name}"):
            try:
                result = await self._run(prompt)
            except AgentFailed as err:
                if on_event:
                    await on_event("agent_done", {"agent": self.name, "run_id": run_id, "ok": False, "error": str(err)})
                raise
        if on_event:
            await on_event("agent_done", {"agent": self.name, "run_id": run_id, "ok": True,
                                          "answer": result.model_dump(mode="json")})
        return result

    async def _run(self, prompt: str) -> T:
        last = ""
        for attempt in range(2):
            text = prompt if attempt == 0 else f"{prompt}\n\nYour previous answer was not valid JSON for the schema. Answer with the JSON object only."
            try:
                with span(f"model call {attempt + 1}"):
                    result = await self._agent.arun(text)
            except Exception as err:  # network, proxy or model errors: retry once, then give up
                last = f"{type(err).__name__}: {err}"
                log.warning("agent %s failed: %s", self.name, last)
                continue
            # agno leaves a plain string when parsing fails
            if isinstance(result.content, self.output_schema):
                return result.content
            last = f"answer was {type(result.content).__name__}, not {self.output_schema.__name__}"
            log.warning("agent %s: %s — got %r", self.name, last, str(result.content)[:300])  # ours: what came back
        raise AgentFailed(f"{self.name}: {last[:300]}")


# ── text agent: writes prose for the user ──

class TextAgent:
    """A plain agno agent for text shown to the user (the answer). Streams each piece of text as an
    `answer_delta` event and returns the whole text; no tools, no schema."""

    def __init__(self, name: str, model: OpenAILike, instructions: list[str]) -> None:
        self.name = name
        self._agent = Agent(name=name, model=model, instructions=instructions, markdown=True, telemetry=False)

    async def run(self, prompt: str, on_event: "EventSink | None" = None) -> str:
        run_id = new_run_id()
        if on_event:
            await on_event("agent_started", {"agent": self.name, "run_id": run_id, "type": "text"})
        with span(f"agent {self.name}"):
            parts: list[str] = []
            try:
                async for ev in self._agent.arun(prompt, stream=True, stream_events=True):
                    if getattr(ev, "event", None) == RunEvent.run_content and getattr(ev, "content", None):
                        parts.append(str(ev.content))
                        if on_event:
                            await on_event("answer_delta", {"agent": self.name, "run_id": run_id, "delta": str(ev.content)})
            except Exception as err:
                raise AgentFailed(f"{self.name}: {type(err).__name__}: {err}"[:300]) from err
            text = "".join(parts).strip()
            if on_event:
                await on_event("agent_done", {"agent": self.name, "run_id": run_id, "ok": bool(text)})
            if not text:
                raise AgentFailed(f"{self.name} wrote nothing")
            return text


# ── tool agents: build the answer with edit tools ──

_TOOL_FRAME = (
    "You are one step of a data question-answering pipeline, not a chatbot. The data lives in our "
    "database; never say you cannot access it. Do only the task below. You build your answer ONLY by "
    "calling the edit tools: each one checks what you give it and returns `ok` or `error … (nothing "
    "changed)` followed by your current answer as JSON. Read tools look things up. Fix every error you "
    "get. Do not write the answer as text: when the current answer is complete, call done."
)


class Draft(Generic[T]):
    """The answer an agent is building; edit tools change it and show it after every call."""

    def __init__(self, value: T, question: str | None = None) -> None:
        self.value = value
        self.question = question  # lets tools check that a pick comes from the question's words
        self.tools: set[str] | None = None   # the tools the agent can call (errors suggest only those)
        self._last_error: str | None = None

    def show(self) -> str:
        return json.dumps(self.value.model_dump(mode="json"), ensure_ascii=False)

    def ok(self, what: str) -> str:
        self._last_error = None
        return f"ok: {what}\ncurrent answer: {self.show()}"

    def error(self, problem: str, steps: Iterable[Step] = ()) -> str:
        """`problem`, then the first of `steps` the agent can take (tools/guide.py)."""
        repeated = problem == self._last_error
        self._last_error = problem
        text = render(problem, steps, self.tools)
        if repeated:
            text += f" — {REPEATED}"
        return f"error: {text}\ncurrent answer: {self.show()}"


EditToolkit = Callable[[Draft[Any]], Toolkit]  # builds the edit toolkit around one run's Draft


@dataclass
class AgentRun(Generic[T]):
    result: T
    text: str                              # what the agent wrote besides tool calls (kept for the trace)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


class ToolAgent(Generic[T]):
    """An agno agent that builds `output_schema` through an edit toolkit (no parser, no free-text answer).

    Each run builds a fresh edit toolkit (pipeline_v4.tools) around a Draft that starts empty, or from
    `initial` (e.g. its previous answer when fixing errors); the answer is the Draft as the tools left
    it. `read` is an optional read toolkit (e.g. ProfileTools with include_tools). Every tool call is
    recorded by an agno tool hook for the trace."""

    def __init__(self, name: str, model: OpenAILike, read: Toolkit | None, edit: EditToolkit,
                 output_schema: type[T], instructions: list[str], tool_call_limit: int = 30,
                 compress_model: OpenAILike | None = None) -> None:
        self.name = name
        self._compress_model = compress_model   # set: tool results are compressed past COMPRESS_AT_TOKENS
        self.output_schema = output_schema
        self._model = model
        self._read = read
        self._edit = edit
        self._instructions = [_TOOL_FRAME, *instructions]
        self._tool_call_limit = tool_call_limit

    def toolkits(self, draft: Draft[T]) -> list[Toolkit]:
        return [*([self._read] if self._read is not None else []), self._edit(draft)]

    async def run(self, prompt: str, on_event: EventSink | None = None, initial: T | None = None,
                  question: str | None = None) -> AgentRun[T]:
        with span(f"agent {self.name}"):
            return await self._run(prompt, on_event, initial, question)

    async def _run(self, prompt: str, on_event: EventSink | None, initial: T | None, question: str | None) -> AgentRun[T]:
        run_id = new_run_id()
        if on_event:
            await on_event("agent_started", {"agent": self.name, "run_id": run_id, "type": "tool",
                                             "fixing": initial is not None})
        draft: Draft[T] = Draft(initial.model_copy(deep=True) if initial is not None else self.output_schema(), question)

        async def compressed(stats: dict[str, Any]) -> None:
            if on_event:
                await on_event("compressed", {"agent": self.name, "run_id": run_id, **stats})

        compression = None
        if self._compress_model is not None:
            from src.pipeline_v4.agents.compression import (
                PipelineCompression,  # local: optional feature
            )

            compression = PipelineCompression(self._compress_model, question, compressed)
        toolkits = self.toolkits(draft)
        draft.tools = tool_names(toolkits)
        agent = Agent(
            name=self.name,
            model=self._model,
            tools=toolkits,
            tool_hooks=[record_tool_call],
            tool_call_limit=self._tool_call_limit,
            compression_manager=compression,
            instructions=self._instructions,
            markdown=False,
            telemetry=False,
        )
        parts: list[str] = []
        calls: list[dict[str, Any]] = []
        token = tool_log.set(calls)
        try:
            async for ev in agent.arun(f"{prompt}\n\n# Your current answer\n{draft.show()}", stream=True, stream_events=True):
                kind = getattr(ev, "event", None)
                call = getattr(ev, "tool", None)
                if kind == RunEvent.tool_call_started and call is not None:
                    if on_event:
                        await on_event("tool_started", {"agent": self.name, "run_id": run_id, "call_id": call.tool_call_id,
                                                        "tool": call.tool_name, "args": call.tool_args or {}})
                elif kind == RunEvent.tool_call_completed and call is not None:
                    if on_event:
                        await on_event("tool_done", {"agent": self.name, "run_id": run_id, "call_id": call.tool_call_id,
                                                     "tool": call.tool_name, "result": str(call.result or "")})
                elif kind == RunEvent.run_content and getattr(ev, "content", None):
                    parts.append(str(ev.content))
                    if on_event:
                        await on_event("agent_delta", {"agent": self.name, "run_id": run_id, "delta": str(ev.content)})
        except Exception as err:
            if on_event:
                await on_event("agent_done", {"agent": self.name, "run_id": run_id, "ok": False, "error": str(err)[:300]})
            raise AgentFailed(f"{self.name}: {type(err).__name__}: {err}"[:300]) from err
        finally:
            tool_log.reset(token)
        text = "".join(parts)
        if on_event:
            await on_event("agent_done", {"agent": self.name, "run_id": run_id, "ok": True, "tool_calls": len(calls),
                                          "answer": draft.value.model_dump(mode="json")})
        return AgentRun(result=draft.value, text=text, tool_calls=calls)
