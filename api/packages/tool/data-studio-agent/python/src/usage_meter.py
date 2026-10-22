"""Token usage of every model call the Data Studio Python makes (docs/admin-usage-dashboard-plan.md §3.4).

One choke point instead of one hook per agent: the openai SDK. agno's OpenAILike (pipelines v3 / v4, chart vision),
the data profile's suggestions (sync OpenAI client) and the embeddings all call `chat.completions.create` or
`embeddings.create`, so wrapping those four methods counts every call, streamed or not, whichever agent made it.

Per question (bridge/runner.py) or admin request (bridge/admin_runner.py): `begin()`, run, `take()` → a list of
{purpose, model, in, out, cacheRead, reasoning, ms, ok}, sent back in the reply's `usage`. Outside begin/take
nothing is recorded. A list in a ContextVar: asyncio tasks and `asyncio.to_thread` copy the context, and the list
itself is shared, so calls made from any of them land in the same question's list.
"""
from __future__ import annotations

import contextvars
import time
from typing import Any

_calls: contextvars.ContextVar[list[dict] | None] = contextvars.ContextVar("discovery_usage_calls", default=None)
_purpose: contextvars.ContextVar[str] = contextvars.ContextVar("discovery_usage_purpose", default="data-studio")
_installed = False


def begin(purpose: str = "data-studio") -> None:
    _calls.set([])
    _purpose.set(purpose)


def take() -> list[dict]:
    calls = _calls.get() or []
    _calls.set(None)
    return calls


def _int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


def _note(model: Any, usage: Any, started: float, ok: bool, purpose: str | None = None) -> None:
    calls = _calls.get()
    if calls is None:
        return
    entry: dict[str, Any] = {
        "purpose": purpose or _purpose.get(),
        "model": str(model or "unknown")[:128],
        "in": 0,
        "out": 0,
        "ms": int((time.monotonic() - started) * 1000),
        "ok": ok,
    }
    if usage is not None:
        get = (lambda k: usage.get(k)) if isinstance(usage, dict) else (lambda k: getattr(usage, k, None))
        entry["in"] = _int(get("prompt_tokens")) or 0
        entry["out"] = _int(get("completion_tokens")) or 0
        details = get("prompt_tokens_details")
        cached = (details.get("cached_tokens") if isinstance(details, dict) else getattr(details, "cached_tokens", None)) if details is not None else None
        if _int(cached) is not None:
            entry["cacheRead"] = _int(cached)
        out_details = get("completion_tokens_details")
        reasoning = (out_details.get("reasoning_tokens") if isinstance(out_details, dict) else getattr(out_details, "reasoning_tokens", None)) if out_details is not None else None
        if _int(reasoning) is not None:
            entry["reasoning"] = _int(reasoning)
    calls.append(entry)


class _MeteredAsyncStream:
    """An openai AsyncStream that notes the usage chunk (stream_options.include_usage) when the stream ends."""

    def __init__(self, stream: Any, model: Any, started: float) -> None:
        self._stream, self._model, self._started = stream, model, started

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        usage = None
        ok = False
        try:
            async for chunk in self._stream:
                if getattr(chunk, "usage", None) is not None:
                    usage = chunk.usage
                yield chunk
            ok = True
        finally:
            _note(self._model, usage, self._started, ok)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        close = getattr(self._stream, "close", None)
        if close is not None:
            result = close()
            if hasattr(result, "__await__"):
                await result

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


class _MeteredStream:
    """The same for the sync client's Stream."""

    def __init__(self, stream: Any, model: Any, started: float) -> None:
        self._stream, self._model, self._started = stream, model, started

    def __iter__(self):
        usage = None
        ok = False
        try:
            for chunk in self._stream:
                if getattr(chunk, "usage", None) is not None:
                    usage = chunk.usage
                yield chunk
            ok = True
        finally:
            _note(self._model, usage, self._started, ok)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        close = getattr(self._stream, "close", None)
        if close is not None:
            close()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def install() -> None:
    """Wraps the openai SDK's chat and embedding calls once per process."""
    global _installed
    if _installed:
        return
    _installed = True
    from openai.resources import embeddings as emb_mod
    from openai.resources.chat import completions as chat_mod

    def wrap_async_chat(original):
        async def create(self, *args, **kwargs):
            started = time.monotonic()
            model = kwargs.get("model")
            if kwargs.get("stream") and _calls.get() is not None:
                # ask the server for the usage chunk at the end of the stream (OpenAI-compatible servers)
                options = dict(kwargs.get("stream_options") or {})
                options.setdefault("include_usage", True)
                kwargs["stream_options"] = options
            try:
                result = await original(self, *args, **kwargs)
            except BaseException:
                _note(model, None, started, False)
                raise
            if kwargs.get("stream"):
                return _MeteredAsyncStream(result, model, started)
            _note(model, getattr(result, "usage", None), started, True)
            return result
        return create

    def wrap_sync_chat(original):
        def create(self, *args, **kwargs):
            started = time.monotonic()
            model = kwargs.get("model")
            if kwargs.get("stream") and _calls.get() is not None:
                options = dict(kwargs.get("stream_options") or {})
                options.setdefault("include_usage", True)
                kwargs["stream_options"] = options
            try:
                result = original(self, *args, **kwargs)
            except BaseException:
                _note(model, None, started, False)
                raise
            if kwargs.get("stream"):
                return _MeteredStream(result, model, started)
            _note(model, getattr(result, "usage", None), started, True)
            return result
        return create

    def wrap_async_embed(original):
        async def create(self, *args, **kwargs):
            started = time.monotonic()
            try:
                result = await original(self, *args, **kwargs)
            except BaseException:
                _note(kwargs.get("model"), None, started, False, "embedding")
                raise
            usage = getattr(result, "usage", None)
            _note(kwargs.get("model"), {"prompt_tokens": getattr(usage, "prompt_tokens", None) or getattr(usage, "total_tokens", None)}, started, True, "embedding")
            return result
        return create

    def wrap_sync_embed(original):
        def create(self, *args, **kwargs):
            started = time.monotonic()
            try:
                result = original(self, *args, **kwargs)
            except BaseException:
                _note(kwargs.get("model"), None, started, False, "embedding")
                raise
            usage = getattr(result, "usage", None)
            _note(kwargs.get("model"), {"prompt_tokens": getattr(usage, "prompt_tokens", None) or getattr(usage, "total_tokens", None)}, started, True, "embedding")
            return result
        return create

    chat_mod.AsyncCompletions.create = wrap_async_chat(chat_mod.AsyncCompletions.create)
    chat_mod.Completions.create = wrap_sync_chat(chat_mod.Completions.create)
    emb_mod.AsyncEmbeddings.create = wrap_async_embed(emb_mod.AsyncEmbeddings.create)
    emb_mod.Embeddings.create = wrap_sync_embed(emb_mod.Embeddings.create)
