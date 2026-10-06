"""Context compression for the pipeline's tool agents (agno CompressionManager).

When an agent's context reaches COMPRESS_AT_TOKENS, its tool results not compressed yet are
shortened for the next model calls (agno keeps the originals; the model sees `compressed_content`):

  edit-tool results   "ok: … / error: …" + "current answer: {json}". Code, no model call: the
                      newest one stays exactly as it is (it is the agent's current answer); older
                      ones keep only their ok/error line (a later answer replaces them)
  short results       kept as they are (nothing to gain, and a summary could lose a name)
  read-tool results   profile lookups, scout answers. First code drops the free-text descriptions
                      (lossless for everything the agent uses: names, labels, types, links, value
                      lists, definitions). Only what is still longer than SUMMARIZE_OVER_CHARS is
                      summarized by the model with PROMPT, told which question the agent is working
                      on; a "summary" that is not shorter is not used

Every compression is reported to `on_compress` (the agent's events) with sizes before and after.
"""

import asyncio
import re
from collections.abc import Awaitable, Callable
from typing import Any

from agno.compression.manager import CompressionManager
from agno.models.base import Model
from agno.models.message import Message

COMPRESS_AT_TOKENS = 20_000
KEEP_UNDER_CHARS = 600          # tool results shorter than this are kept as they are
SUMMARIZE_OVER_CHARS = 3_000    # read results still longer than this after dropping descriptions go to the model
EDIT_MARK = "\ncurrent answer: "

# formats of pipeline_v4/context.py (render_table, render_column) and tools/profile.py:
#   "<name> — “<label>” …"                        a label: kept
#   "<column> <type> … (<flags>) — <free text> · all values: …"   the free text is dropped
#   "   <free text>" right after "   one row = …" in a table block: dropped
_DESCRIPTION = re.compile(r" — (?!“)(?:(?! · ).)*")
_TABLE_KEYS = ("one row =", "main time column:", "always applied:", "caveat:", "columns")   # "columns (12 of 150):"

PROMPT = """\
You shorten the result of one tool call made by an agent of a data question-answering pipeline.
The agent looks things up in a data profile (tables, columns, stored values, relationships,
metrics, business terms), matches the user's words to them, and then calls other tools with the
EXACT names it saw. Your text replaces the tool result in the agent's memory: anything you drop or
change is lost to it.

KEEP, copied exactly as written (never translate, re-case, shorten or "fix" a name, a label or a code):
- every name: tables, columns as table.column, metrics, business terms
- the display name or label in quotes next to a name ("…"): it is how the user's words are matched
- stored values as code = label
- for a table: what one row is, its main time column (with its time zone), the conditions always
  applied to it, and the columns that identify a row
- for a column: its type and role words (key, id, dimension, measure, datetime, …) and its links
  ("links to table.column", "identifies the row")
- for a metric: what it computes, of which table, its conditions and its unit [in brackets]
- for a business term: its kind and its definition (e.g. "segment of <table>: <conditions>")
- relationships: the two tables, the columns that link them, and whether a row matches one row or
  many rows (1:N, N:1, "at most one row", "many rows")
- errors, "not found" messages and suggested names ("did you mean …")
- facts given as answers (one line each, with the names they cite)

SHORTEN, and only these:
- free-text descriptions (the text after " — "): drop them, or keep at most five words when they
  say something the name and label do not
- long lists: keep every item whose name, label or definition relates to the question; then one
  line "… N more not shown" with their names only

REMOVE: decoration, repeated lines, anything that is not in the tool result.

Write plain lines in the same order, one item per line, no introduction and no comment. Never add,
guess, reword or merge information.
"""

OnCompress = Callable[[dict[str, Any]], Awaitable[None]]


def strip_descriptions(text: str) -> str:
    """The tool result without its free-text descriptions; everything else exactly as it was."""
    out: list[str] = []
    prev = ""
    for line in text.split("\n"):
        body = line.strip()
        if prev.strip().startswith("one row =") and line.startswith("   ") and not line.startswith("    ") \
                and not body.startswith(_TABLE_KEYS):
            prev = line
            continue          # the table's description line
        out.append(_DESCRIPTION.sub("", line))
        prev = line
    return "\n".join(out)


def is_edit_result(msg: Message) -> bool:
    return EDIT_MARK in str(msg.content or "")


def status_line(content: str) -> str:
    return content.split(EDIT_MARK, 1)[0].strip()


class PipelineCompression(CompressionManager):
    """agno's CompressionManager with code rules for edit-tool results and short results, a prompt
    for data-profile lookups, and the agent's question as context (async only: the pipeline uses arun)."""

    def __init__(self, model: Model, question: str | None = None, on_compress: OnCompress | None = None,
                 token_limit: int = COMPRESS_AT_TOKENS) -> None:
        super().__init__(model=model, compress_tool_results=True, compress_token_limit=token_limit,
                         compress_tool_call_instructions=PROMPT)
        self.question = question
        self.on_compress = on_compress

    async def _acompress_tool_result(self, tool_result: Message, run_metrics: Any = None) -> str | None:
        stripped = strip_descriptions(str(tool_result.content or ""))
        if len(stripped) <= SUMMARIZE_OVER_CHARS:
            return stripped if len(stripped) < len(str(tool_result.content)) else None
        content = f"Tool: {tool_result.tool_name or 'unknown'}\n{stripped}"
        context = f"Question the agent is working on: {self.question}\n\n" if self.question else ""
        assert self.model is not None
        try:
            response = await self.model.aresponse(messages=[
                Message(role="system", content=PROMPT),
                Message(role="user", content=f"{context}Tool result to shorten:\n{content}\n"),
            ])
        except Exception:  # noqa: BLE001 — keep the original rather than lose it
            return None
        text = (response.content or "").strip()
        return text if text and len(text) < len(stripped) else stripped  # a longer "summary" is useless

    async def acompress(self, messages: list[Message], run_metrics: Any = None) -> None:
        tools = [m for m in messages if m.role == "tool"]
        if not tools:
            return
        before = sum(len(str(m.get_content(use_compressed_content=True) or "")) for m in tools)
        edits = [m for m in tools if is_edit_result(m)]
        newest_edit = edits[-1] if edits else None
        for m in edits:   # re-checked every time: an answer kept whole earlier may be superseded now
            m.compressed_content = str(m.content) if m is newest_edit else status_line(str(m.content))
        pending = [m for m in tools if m.compressed_content is None]
        for m in pending:
            if len(str(m.content or "")) < KEEP_UNDER_CHARS:
                m.compressed_content = str(m.content or "")
        reads = [m for m in pending if m.compressed_content is None]
        shortened = await asyncio.gather(*(self._acompress_tool_result(m) for m in reads))
        for m, text in zip(reads, shortened, strict=True):
            m.compressed_content = text if text is not None else str(m.content or "")
        after = sum(len(str(m.get_content(use_compressed_content=True) or "")) for m in tools)
        self.stats["tool_results_compressed"] = self.stats.get("tool_results_compressed", 0) + len(pending)
        self.stats["original_size"] = self.stats.get("original_size", 0) + before
        self.stats["compressed_size"] = self.stats.get("compressed_size", 0) + after
        if self.on_compress:
            await self.on_compress({"tool_results": len(tools), "shortened": sum(t is not None for t in shortened),
                                    "chars_before": before, "chars_after": after})
