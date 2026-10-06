"""Toolkits of the decomposer and of the scout it asks about the data.

  AskDataTools     read tool of the decomposer: ask_data(question) runs the scout and returns its facts
  ScoutTools       edit tool of the scout: add_fact(fact, names) — names must be real profile names
  DecomposeTools   edit tools of the decomposer: set_standalone, add_part — each checks that it only uses
                   words already in the question / the conversation (standalone) or in standalone (parts)
"""

from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

from agno.tools import Toolkit

from src.pipeline_v4.agents.base import Draft
from src.pipeline_v4.agents.parts import DecomposeOut, PartOut, ScoutFact, ScoutOut
from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.context import Names, UnknownName
from src.pipeline_v4.tools.drafts import DraftToolkit
from src.pipeline_v4.tools.guide import Run, options

MAX_PARTS = 3
MAX_QUESTIONS = 4   # ask_data calls per decomposer run


def extra_words(text: str, allowed: set[str]) -> list[str]:
    """Words of `text` (as written) that are not among `allowed` (compared without accents and case)."""
    from src.pipeline_v4.retrieve import (
        words,  # local: retrieve imports the agents package
    )

    return list(dict.fromkeys(t.strip(".,;:!?()'\"") for t in text.split() if any(w not in allowed for w in words(t))))


def invented_words(text: str, allowed: set[str], data: set[str] | None) -> list[str]:
    """Words of `text` (as written) that bring in content not in `allowed`: a number, or a word naming
    something of the data (`data`: words of table, column, metric, term and value names). Other new words
    ('bn' written out as 'bao nhiêu') are fine. data=None: every new word counts."""
    from src.pipeline_v4.retrieve import words

    def new(w: str) -> bool:
        return w not in allowed and (data is None or w in data or any(ch.isdigit() for ch in w))

    return list(dict.fromkeys(t.strip(".,;:!?()'\"") for t in text.split() if any(new(w) for w in words(t))))


def data_words(cat: Catalog) -> set[str]:
    """Every word that names something of the data: tables, columns, metrics, terms, stored values."""
    from src.pipeline_v4.retrieve import words

    texts: list[str] = []
    for t in cat.tables.values():
        texts += [t.display_name, t.physical_name, t.physical_name.replace("_", " "), *t.synonyms]
    for c in cat.columns.values():
        texts += [c.display_name, c.physical_name.replace("_", " "), *c.synonyms]
        for item in c.profile.value_catalog:
            texts += [item.value, item.label or "", *item.synonyms]
    for m in cat.metrics.values():
        texts += [m.get("display_name") or "", (m.get("name") or "").replace("_", " "), *(m.get("synonyms") or [])]
    for g in cat.glossary.values():
        texts += [g.get("term") or "", *(g.get("synonyms") or [])]
    return {w for t in texts if t for w in words(t)}


def word_set(text: str) -> set[str]:
    from src.pipeline_v4.retrieve import words

    return set(words(text))


class ScoutTools(DraftToolkit):
    parts: ClassVar = {"facts": lambda x: x.fact}

    def __init__(self, draft: Draft[ScoutOut], names: Names, **kwargs: Any) -> None:
        self.h = names
        super().__init__("scout_tools", draft, [self.add_fact], **kwargs)

    async def add_fact(self, fact: str, names: list[str]) -> str:
        """Add one finding that answers the question, as a short sentence.

        Args:
            fact: what the tools showed, e.g. "<b> is a table; each <a> row points to one <b> row (<a>.<b_id>)".
            names: the exact profile names the fact is about (tables, table.column, metrics, terms).
        """
        if not fact.strip():
            return self.error("the fact is empty", "send fact = one short sentence of what the tools showed")
        canon = []
        for n in names:
            try:
                canon.append(self.h.of(self.h.resolve(n)))
            except UnknownName as err:
                close = [f"send names with: {options(err.suggestions)}"] if err.suggestions else []
                return self.error(str(err), *close, Run.of("search_profile", text=n),
                                  "send in names only the exact names the tools showed")
        self.draft.value.facts.append(ScoutFact(fact=fact.strip(), names=canon))
        return self.ok("fact added")


Ask = Callable[[str], Awaitable[ScoutOut]]


class AskDataTools(Toolkit):
    """Read tool of the decomposer. `ask` runs the scout on one question."""

    def __init__(self, ask: Ask, **kwargs: Any) -> None:
        self.ask = ask
        self.asked = 0
        super().__init__(name="ask_data_tools", tools=[self.ask_data], **kwargs)

    async def ask_data(self, question: str) -> str:
        """Ask a scout what the database holds: whether a word names a table, a column, a stored value or a
        business term; what one row of a table is; whether two things are related. The scout looks it up in
        the data profile and answers with facts.

        Args:
            question: one short question about the data, e.g. "is <B> a table, and is it related to <A>?".
        """
        if self.asked >= MAX_QUESTIONS:
            return (f"no more questions: {MAX_QUESTIONS} already asked. Next: decide with the facts you have "
                    "(when unsure, keep the question as one part)")
        self.asked += 1
        out = await self.ask(question)
        if not out.facts:
            return ("the scout found nothing about it. Next: ask once more with other words (a synonym, a shorter "
                    "phrase), or treat it as not in the data")
        return "\n".join(f"- {f.fact}" + (f" ({', '.join(f.names)})" if f.names else "") for f in out.facts)


class DecomposeTools(DraftToolkit):
    parts: ClassVar = {"parts": lambda x: x.question}

    def __init__(self, draft: Draft[DecomposeOut], question: str, history_text: str,
                 data: set[str] | None = None, **kwargs: Any) -> None:
        self.source, self.data = word_set(question) | word_set(history_text), data
        super().__init__("decompose_tools", draft, [self.set_standalone, self.add_part], **kwargs)

    async def set_standalone(self, text: str) -> str:
        """Set the question as it stands alone (references to the conversation replaced by what they refer to).

        Args:
            text: the standalone question, in the user's language.
        """
        if not text.strip():
            return self.error("the standalone question is empty", "send text = the user's question as it stands alone")
        if (extra := invented_words(text, self.source, self.data)):
            return self.error(f"brings in names of the data or numbers that are neither in the question nor in the "
                              f"conversation: {', '.join(extra)}",
                              "send it again without those words: names, values and numbers must come from the "
                              "question or the conversation (other wording is free)")
        self.draft.value.standalone = text.strip()
        return self.ok("standalone set")

    async def add_part(self, question: str, depends_on: list[int] | None = None) -> str:
        """Add a part: a question answered on its own with one result table.

        Args:
            question: the part, using only words of the standalone question.
            depends_on: numbers (1, 2, …) of earlier parts whose result it needs; empty when it stands alone.
        """
        v = self.draft.value
        if not v.standalone:
            return self.error("the standalone question is not set yet", "call set_standalone, then add_part")
        if len(v.parts) >= MAX_PARTS:
            return self.error(f"there are already {MAX_PARTS} parts, the most allowed",
                              "call done, or remove a part and merge it into another")
        if not question.strip():
            return self.error("the part is empty", "send question = one part, in words of the standalone question")
        if (extra := invented_words(question, word_set(v.standalone), self.data)):
            return self.error(f"brings in names of the data or numbers that are not in the standalone question: "
                              f"{', '.join(extra)}",
                              f"send it again using only words of: {v.standalone}")
        if word_set(question) in [word_set(p.question) for p in v.parts]:
            return self.duplicate("this part")
        n = len(v.parts) + 1
        deps = list(depends_on or [])
        if any(not 1 <= d < n for d in deps):
            return self.error(f"depends_on may name only earlier parts (1 … {n - 1})",
                              "send depends_on = [] when the part stands alone" if n == 1
                              else f"send depends_on with numbers from 1 to {n - 1}, or []")
        v.parts.append(PartOut(question=question.strip(), depends_on=deps))
        return self.ok(f"part {n}")
