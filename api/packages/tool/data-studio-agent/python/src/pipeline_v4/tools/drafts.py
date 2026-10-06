"""DraftToolkit: the base of every edit toolkit.

An agent builds its answer (a Pydantic model held in a Draft) only through the edit tools of its
toolkit. Every edit tool checks its input before changing anything and answers `ok: …` or
`error: … (nothing changed)`, followed by the current answer as JSON. Shared tools:
  remove   delete one item of a list part (when the toolkit lists removable `parts`)
  done     ends the agent's turn (agno stop_after_tool_call)
  search_phrase  (toolkits whose tools take a `phrase`) the question's own words around a pattern
AnswerDraftToolkit adds set_status and add_assumption for answers that can ask the user.
"""

from collections.abc import Callable
from typing import Any, ClassVar

from agno.tools import Toolkit

from src.pipeline_v4.agents.base import Draft
from src.pipeline_v4.tools.common import question_spans, same
from src.pipeline_v4.tools.guide import Step, options, steps_of


class DraftToolkit(Toolkit):
    # list part → how to name one of its items (for `remove`)
    parts: ClassVar[dict[str, Callable[[Any], str]]] = {}
    phrased: ClassVar[bool] = False   # its tools take a `phrase` of the question: add search_phrase

    def __init__(self, name: str, draft: Draft[Any], tools: list[Callable[..., Any]], **kwargs: Any) -> None:
        self.draft = draft
        shared = [self.remove] if self.parts else []
        if self.phrased:
            shared.append(self.search_phrase)
        super().__init__(name=name, tools=[*tools, *shared, self.done], stop_after_tool_call_tools=["done"], **kwargs)

    def ok(self, what: str) -> str:
        return self.draft.ok(what)

    def error(self, problem: str, *steps: Step) -> str:
        """`error: problem (nothing changed). Next: …` with the first step the agent can take:
        `steps` given here, then those the problem carries (tools/guide.py)."""
        return self.draft.error(problem, (*steps, *steps_of(problem)))

    def duplicate(self, what: str) -> str:
        return self.error(f"{what} is already in your answer",
                          "add only what is still missing, or call done if your answer is complete")

    async def done(self) -> str:
        """Call when your current answer is complete; ends your turn."""
        return "finished"

    async def search_phrase(self, pattern: str) -> str:
        """Find the question's exact words to use as a `phrase`: the spans of the question around the
        words that match the pattern.

        Args:
            pattern: one or a few words, e.g. a name of what you are adding.
        """
        question = self.draft.question
        if not question:
            return "no question to search"
        spans = question_spans(question, pattern)
        if not spans:
            return f"no words of the question match {pattern!r}; the question is: {question}"
        return "exact words of the question (copy one as phrase):\n" + "\n".join(f'- "{s}"' for s in spans)

    async def remove(self, part: str, item: str) -> str:
        """Remove one item from your answer.

        Args:
            part: which list of your current answer, e.g. tables, metrics, filters.
            item: the item's name (or column, phrase, start date) as shown in the current answer.
        """
        if part not in self.parts:
            return self.error(f"{part!r} is not a part of your answer", f"send part as one of: {options(self.parts)}")
        current = getattr(self.draft.value, part)
        key = self.parts[part]
        keep = [x for x in current if not same(key(x), item)]
        if len(keep) == len(current):
            if not current:
                return self.error(f"{part} is empty: there is nothing to remove", "call done if your answer is complete")
            return self.error(f"no {part} item {item!r}",
                              f"send item as written in your current answer: {options(key(x) for x in current)}")
        setattr(self.draft.value, part, keep)
        return self.ok(f"removed {item!r} from {part}")


class AnswerDraftToolkit(DraftToolkit):
    """For answers with status / message / options / assumptions."""

    def __init__(self, name: str, draft: Draft[Any], tools: list[Callable[..., Any]], **kwargs: Any) -> None:
        super().__init__(name, draft, [*tools, self.set_status, self.add_assumption], **kwargs)

    async def set_status(self, status: str, message: str = "", options: list[str] | None = None) -> str:
        """Set how this step ends: ok (default), clarify (ask the user: message = the question,
        options = 2-4 choices taken from the profile) or cannot_answer (message = why).

        Args:
            status: ok, clarify or cannot_answer.
            message: the question for clarify, or the reason for cannot_answer.
            options: choices for clarify.
        """
        if status not in ("ok", "clarify", "cannot_answer"):
            return self.error(f"status {status!r} is unknown", "send status as ok, clarify or cannot_answer")
        if status != "ok" and not message.strip():
            return self.error(f"{status} needs a message",
                              "send message = the question to ask the user" if status == "clarify"
                              else "send message = why the question can't be answered from this data")
        v = self.draft.value
        v.status, v.message, v.options = status, message.strip() or None, list(options or [])
        return self.ok(f"status {status}")

    async def add_assumption(self, text: str) -> str:
        """Note a choice the user should know about, e.g. which metric was used.

        Args:
            text: one short sentence.
        """
        if not text.strip():
            return self.error("the assumption is empty", "send text = one short sentence about a choice you made")
        if any(same(a, text) for a in self.draft.value.assumptions):
            return self.duplicate("this assumption")
        self.draft.value.assumptions.append(text.strip())
        return self.ok("assumption added")
