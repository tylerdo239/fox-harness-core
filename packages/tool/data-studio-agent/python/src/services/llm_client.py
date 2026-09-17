import inspect
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import TypeVar

from agno.agent import Agent
from agno.models.openai.like import OpenAILike
from pydantic import BaseModel

from src.settings import Settings

SchemaT = TypeVar("SchemaT", bound=BaseModel)

DEBUG_LOG_DIR = Path("debug_logs")


def _dump_run(run_dir: Path, seq: int, caller: str, run) -> None:
    """Dev-only: dump every agent call's full message exchange + output to a local file,
    so a bad structured result can be traced back to what the model actually saw and said —
    not just the parsed output. Never raises; a logging failure must not break the pipeline."""
    try:
        run_dir.mkdir(parents=True, exist_ok=True)
        path = run_dir / f"{seq:02d}_{caller}.json"

        messages = [
            {"role": m.role, "content": m.content}
            for m in (run.messages or [])
        ]
        content = run.content
        output = content.model_dump() if isinstance(content, BaseModel) else content

        path.write_text(
            json.dumps(
                {"caller": caller, "messages": messages, "output": output},
                indent=2,
                default=str,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


def _caller_name() -> str:
    """Best-effort label for which pipeline step made this call, e.g. 'schema_linking.select_schema'."""
    frame = inspect.currentframe()
    try:
        outer = frame.f_back.f_back  # skip _caller_name + run_structured/run_text
        module = outer.f_globals.get("__name__", "?").rsplit(".", 1)[-1]
        func = outer.f_code.co_name
        return f"{module}.{func}"
    except Exception:
        return "unknown"
    finally:
        del frame


class LLMClient:
    def __init__(self, settings: Settings) -> None:
        self._model = OpenAILike(
            id=settings.openai_model_id,
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            extra_body=settings.openai_extra_body or None,
        )
        # One subfolder per LLMClient instance (i.e. per pipeline run, see chat.py) so a
        # run's agent calls are grouped together instead of interleaved with every other
        # run's files in one flat directory.
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%f")
        self._run_dir = DEBUG_LOG_DIR / timestamp
        self._call_seq = 0

    def _next_seq(self) -> int:
        self._call_seq += 1
        return self._call_seq

    async def run_structured(
        self,
        prompt: str,
        output_schema: type[SchemaT],
        instructions: str | list[str] | None = None,
    ) -> SchemaT:
        caller = _caller_name()
        agent = Agent(
            model=self._model,
            instructions=instructions,
            output_schema=output_schema,
            debug_mode=True,
        )
        run = await agent.arun(prompt)
        _dump_run(self._run_dir, self._next_seq(), caller, run)
        return run.content

    async def run_text(self, prompt: str, instructions: str | list[str] | None = None) -> str:
        caller = _caller_name()
        agent = Agent(model=self._model, instructions=instructions, debug_mode=True)
        run = await agent.arun(prompt)
        _dump_run(self._run_dir, self._next_seq(), caller, run)
        return run.content

    async def stream_text(
        self, prompt: str, instructions: str | list[str] | None = None
    ):
        """Async generator yielding text content DELTAS as the model produces them, so callers
        can forward tokens to the UI immediately instead of waiting for the whole response. Used
        for markdown answers/insights where streaming beats structured JSON for latency + UX."""
        caller = _caller_name()
        agent = Agent(model=self._model, instructions=instructions, debug_mode=True)
        parts: list[str] = []
        async for event in agent.arun(prompt, stream=True):
            delta = getattr(event, "content", None)
            if delta:
                parts.append(delta)
                yield delta
        # persist the assembled text for debugging (mirrors the non-streaming dumps)
        try:
            path = self._run_dir / f"{self._next_seq():02d}_{caller}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({"caller": caller, "streamed_text": "".join(parts)},
                           indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass
