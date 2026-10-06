"""Checks shared by the toolkits: names, question grounding, value text, validation messages."""

from typing import Any

from pydantic import ValidationError

from src.pipeline_v4.agents.base import Draft
from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.context import Kind, Names, UnknownName
from src.pipeline_v4.tools.guide import Problem, Run, lookup_steps, options

Scalar = str | int | float | bool  # agents send JSON true / 1 as often as "true" / "1"
TIME_TYPES = ("DATE", "TIMESTAMP", "TIMESTAMPTZ", "DATETIME")


def canonical(h: Names, name: str, kind: Kind) -> tuple[str | None, str]:
    """(the canonical name, "") or (None, the problem with close names and how to find the right one)."""
    try:
        return h.of(h.resolve(name, kind)), ""
    except UnknownName as err:
        close = (f"use one of: {options(err.suggestions)}",) if len(err.suggestions) == 1 else ()
        return None, Problem(str(err), *close, *lookup_steps(kind, str(name)))


def as_text(value: Scalar) -> str:
    """A value as the text the profile stores: true/false for booleans, 5 for 5.0."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def same(a: str | None, b: str | None) -> bool:
    return " ".join(str(a or "").lower().split()) == " ".join(str(b or "").lower().split())


def validation_message(err: ValidationError) -> str:
    return "; ".join(f"{'.'.join(map(str, e.get('loc', ()))) or 'value'}: {e.get('msg')}" for e in err.errors())


def not_in_question(d: Draft[Any], phrase: str) -> str:
    """"" when every word of `phrase` is in the question (accents and case ignored), else the problem."""
    if d.question is None:
        return ""
    from src.pipeline_v4.retrieve import (
        words,  # local: retrieve imports the agents package
    )

    if not words(phrase):
        return Problem("phrase is empty: say which words of the question this comes from",
                       "copy the words of the question that ask for it into phrase")
    have = set(words(d.question))
    missing = [w for w in words(phrase) if w not in have]
    if missing:
        found = [t for t in phrase.split() if words(t) and all(w in have for w in words(t))]
        pattern = " ".join(found) or phrase
        return Problem(f"{phrase!r} is not in the question (missing: {', '.join(missing)}); a phrase is the "
                       "question's own words", Run.of("search_phrase", pattern=pattern),
                       f"copy the exact words from the question: {d.question}")
    return ""


def question_spans(question: str, pattern: str, around: int = 2) -> list[str]:
    """Spans of the question, exactly as written, around the words that match `pattern` (accents,
    case and a plural 's' ignored; a pattern word of 3+ letters also matches the start of a word)."""
    from src.pipeline_v4.retrieve import (
        words,  # local: retrieve imports the agents package
    )

    tokens = question.split()
    want = words(pattern)
    if not want:
        return []

    def hit(token: str) -> bool:
        return any(w == p or (len(p) >= 3 and w.startswith(p)) for w in words(token) for p in want)

    hits = [i for i, t in enumerate(tokens) if hit(t)]
    spans: list[str] = []

    def add(a: int, b: int) -> None:
        text = " ".join(tokens[max(a, 0):min(b, len(tokens))]).strip(".,;:!?()'\"")
        if text and text not in spans:
            spans.append(text)

    for i in hits:
        add(i, i + 1)
    if len(hits) > 1:
        add(hits[0], hits[-1] + 1)
    for i in hits:
        add(i - around, i + 1)
        add(i, i + around + 1)
    return spans


def is_time(cat: Catalog, h: Names, column: str) -> bool:
    col = cat.columns[h.resolve(column, "column")]
    return col.data_type in TIME_TYPES or bool(col.profile.date_format)


def value_problem(cat: Catalog, h: Names, column: str, values: list[str]) -> str:
    """"" when the values are stored codes of the column (only checked for complete value lists)."""
    p = cat.columns[h.resolve(column, "column")].profile
    if not (p.value_catalog_complete and p.value_catalog):
        return ""
    codes = {i.value for i in p.value_catalog}
    for v in values:
        if v not in codes:
            hint = next((i.value for i in p.value_catalog if same(i.label, v)), None)
            if hint:
                return Problem(f"{v!r} is a label of {column}, not its stored code", f"send the stored code {hint!r}")
            return Problem(f"{v!r} is not a stored value of {column}",
                           Run.of("list_values", column=column, contains=v),
                           f"use one of its stored codes: {options(sorted(codes))}")
    return ""


def filter_problem(cat: Catalog, h: Names, column: str, op: str, values: list[str]) -> str:
    if op in ("is_null", "is_not_null"):
        return "" if not values else Problem(f"{op} takes no value", "send the same call with an empty values list")
    if not values:
        return Problem(f"{op} needs a value", Run.of("list_values", column=column),
                       "send the value the question names in values")
    return value_problem(cat, h, column, values)
