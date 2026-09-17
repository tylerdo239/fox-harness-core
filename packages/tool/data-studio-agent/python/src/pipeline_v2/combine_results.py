"""Combines a decomposed question's sub-answers into one STREAMED MARKDOWN answer + insights.

Only the narrative is combined and streamed as markdown (token-by-token to the UI). Charts stay
PER SUB-QUESTION — this step never merges charts. It produces one overall answer tying the
sub-answers together, plus insights that may reference across them.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from src.services.llm_client import LLMClient

_MAX_ROWS_PER_SUB = 30

EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]

_INSTRUCTIONS = """\
# Role
Several sub-questions of one bigger question have each been answered with their own query result.
Write ONE combined answer and a few insights that tie them together, as **markdown**.

# CRITICAL — language
Write everything in the SAME language as the original question (usually **Vietnamese** — answer in
Vietnamese if the original is Vietnamese). Never default to English.

# Format (markdown, no headings)
- Start with a **1–3 sentence** answer to the ORIGINAL question as a whole, synthesizing the
  sub-answers (not just listing them).
- Then a markdown bullet list (`- `) of **3–6** insights. You may connect findings ACROSS
  sub-questions (e.g. "the agent with the most workflows also has the most conversations"). Quote
  real values; **bold** key numbers; never invent numbers.
- No JSON, no headings, no title — just the answer paragraph then the bullets.

# Rules
- Each sub-result's rows are DISTINCT records; never sum rows that merely share a name.
- Concise and factual. No preamble.
"""


def _render(original_question: str, ordered_subs: list[tuple[str, dict[str, Any]]]) -> str:
    lines = [f"Original question: {original_question}", "", "Sub-question results:"]
    for sid, res in ordered_subs:
        lines.append(f"\n[{sid}] {res.get('question', '')}")
        if not res.get("success"):
            lines.append("  (no answer / needs clarification)")
            continue
        rows = res.get("rows") or []
        for r in rows[:_MAX_ROWS_PER_SUB]:
            lines.append(f"  {r}")
    return "\n".join(lines)


async def stream_combined(
    llm_client: LLMClient,
    original_question: str,
    ordered_subs: list[tuple[str, dict[str, Any]]],
    on_event: EventSink,
) -> str:
    """Streams the combined markdown answer+insights via 'combined_delta' events. Returns the
    full markdown. Charts are NOT combined (they live on each sub-result)."""
    answered = [
        (sid, r) for sid, r in ordered_subs
        if r.get("success") and (r.get("rows") or r.get("answer_markdown"))
    ]
    if not answered:
        return ""
    prompt = _render(original_question, ordered_subs)
    parts: list[str] = []
    async for delta in llm_client.stream_text(prompt, instructions=_INSTRUCTIONS):
        parts.append(delta)
        await on_event("combined_delta", {"delta": delta})
    return "".join(parts)
