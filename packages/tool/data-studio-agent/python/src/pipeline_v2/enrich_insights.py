"""9a — Answer + insights as STREAMED MARKDOWN (LLM over the executed result).

Reads the actual result rows and writes a short answer plus a few grounded bullet insights, as
one flowing **markdown** document that is STREAMED token-by-token to the UI. Streaming markdown
beats structured JSON here: the user sees text appear immediately instead of waiting for a whole
JSON object, and markdown renders as a readable answer + bullets without a rigid schema.

Every insight must cite real numbers from the rows — the model is told to quote values, not
generalize, so the output stays verifiable against the data.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from src.services.llm_client import LLMClient

# cap rows sent to the model so a large result doesn't blow the context.
_MAX_ROWS = 60

# on_event(event_type, payload) — used to stream markdown deltas to the UI
EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]

_INSTRUCTIONS = """\
# Role
You are a data analyst. Given a question and its query result, write a short answer and a few
insights as **markdown**.

# CRITICAL — language
Write everything in the SAME language as the question (usually **Vietnamese** — answer in
Vietnamese if the question is Vietnamese). Never default to English.

# Format (markdown, no headings)
- Start with a **1–2 sentence** short answer paragraph — the direct answer.
- Then a markdown bullet list (`- `) of **3–6** insights, each a specific observation GROUNDED in
  the numbers. Quote real values from the rows (e.g. "max BMI **67.1** at age 26"). You may use
  **bold** for key numbers. Do NOT invent numbers.
- Do NOT output JSON, headings, or a title — just the answer paragraph then the bullets.

# Watch for
- Anomalies: zeros/nulls that look like missing data, sudden drops, tiny sample sizes, outliers.
- Never sum same-named rows: rows sharing a display name are DIFFERENT records — report them
  separately, never merge or add their values.

# Style
Concise, factual. No preamble, no restating the question.
"""


def _render(
    question: str,
    sql: str,
    display_columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    row_count: int,
) -> str:
    col_lines = [
        f"- {c.get('physical_name')} ({c.get('display_name')}, {c.get('semantic_type') or '?'})"
        for c in display_columns
    ] or ["- (columns not annotated)"]
    shown = rows[:_MAX_ROWS]
    lines = [
        f"Question: {question}",
        "\nResult columns:\n" + "\n".join(col_lines),
        f"\nRow count: {row_count}" + (f" (showing first {_MAX_ROWS})" if row_count > _MAX_ROWS else ""),
        "\nRows:",
    ]
    for r in shown:
        lines.append(str(r))
    return "\n".join(lines)


async def stream_insights(
    llm_client: LLMClient,
    question: str,
    sql: str,
    display_columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    row_count: int,
    on_event: EventSink,
    event_type: str = "insights_delta",
    extra_payload: dict[str, Any] | None = None,
) -> str:
    """Streams the markdown answer+insights. Each token delta is emitted as `event_type` with
    {"delta": <text>, **extra_payload}; a final `event_type`-done marker is the caller's job.
    Returns the full assembled markdown (also stored on the result for non-streaming consumers)."""
    if not rows:
        text = "Truy vấn không trả về dòng nào cho câu hỏi này." if _looks_vietnamese(question) \
            else "The query returned no rows for this question."
        await on_event(event_type, {"delta": text, **(extra_payload or {})})
        return text

    prompt = _render(question, sql, display_columns, rows, row_count)
    parts: list[str] = []
    async for delta in llm_client.stream_text(prompt, instructions=_INSTRUCTIONS):
        parts.append(delta)
        await on_event(event_type, {"delta": delta, **(extra_payload or {})})
    return "".join(parts)


def _looks_vietnamese(text: str) -> bool:
    return any(ch in text for ch in "ăâđêôơưàáảãạ")
