"""ProfileTools: read the data profile (tables, columns, values, relationships, search).

An agno Toolkit of async tools over the in-memory catalog and the search index. Agents take only
the tools they need with `include_tools`. Tools take and return real names (`conversations`,
`agents.name`, `dem_conversation`); a wrong name or an empty result is answered with a hint and
close names, never an exception, so the agent can correct itself.
"""

from typing import Any

from agno.tools import Toolkit

from src.pipeline_v4.agents.keywords import KeyPhrase, Keywords
from src.pipeline_v4.catalog import Catalog, Column
from src.pipeline_v4.context import (
    Names,
    UnknownName,
    render_column,
    render_metric,
    render_table,
    render_term,
)
from src.pipeline_v4.retrieve import Searcher, normalize, retrieve, words
from src.pipeline_v4.timing import timed
from src.pipeline_v4.tools.guide import (
    Run,
    Step,
    lookup_steps,
    options,
    render,
    tool_names,
)

_KINDS = ("any", "table", "column", "metric", "term", "value")
DESCRIBE_PAGE = 40   # columns per describe_table page


def _column_matches(c: Column, want: list[str]) -> bool:
    """Every word of `want` starts a word of the column's name, display name, description, synonyms or
    values (accents and case ignored)."""
    texts = [c.physical_name.replace("_", " ").replace(".", " "), c.display_name, c.description or "",
             *c.synonyms, *(t for v in c.profile.value_catalog for t in (v.value, v.label or "", *v.synonyms))]
    have = {w for t in texts for w in words(t)}
    return bool(want) and all(any(h == w or (len(w) >= 3 and h.startswith(w)) for h in have) for w in want)
_MAX_LINES = 8


class ProfileTools(Toolkit):
    def __init__(self, cat: Catalog, names: Names, searcher: Searcher | None,
                 data_source_ids: list[str] | None = None, **kwargs: Any) -> None:
        self.cat, self.h, self.searcher, self.scope = cat, names, searcher, data_source_ids
        super().__init__(name="profile_tools",
                         tools=[self.search_profile, self.describe_table, self.list_values, self.join_path,
                                self.search_term], **kwargs)

    @timed("tool search_term")
    async def search_term(self, pattern: str = "") -> str:
        """List the business terms whose name, synonyms or definition match the pattern (every term when
        the pattern is empty), with their kind and definition. Use a term's name exactly as listed.

        Args:
            pattern: a few words of the question, in its language or in English; empty lists every term.
        """
        h, want = self.h, set(words(str(pattern)))
        scored = []
        for gid, g in self.cat.glossary.items():
            if gid not in h.name_of:
                continue
            text = " ".join([h.of(gid), *(g.get("synonyms") or []), g.get("definition") or ""])
            score = len(want & set(words(text))) if want else 1
            if score:
                scored.append((-score, h.of(gid), gid))
        if not scored:
            return (f"no business term matches {pattern!r}" if want else "there are no business terms") + \
                "; if the question uses no term, add none"
        return "\n".join("term " + render_term(gid, h) for _, _, gid in sorted(scored)[:_MAX_LINES])

    def _guide(self, problem: str, *steps: Step) -> str:
        """A failed lookup with the first next step this toolkit offers (tools/guide.py)."""
        return render(problem, steps, tool_names([self])).replace(" (nothing changed)", "")

    def _unknown(self, err: UnknownName) -> str:
        close = [f"use one of: {options(err.suggestions)}"] if len(err.suggestions) == 1 else []
        return self._guide(str(err), *close, *lookup_steps(err.kind, err.name))

    def _table(self, name: str) -> tuple[str | None, str]:
        try:
            return self.h.resolve(name, "table"), ""
        except UnknownName as err:
            return None, self._unknown(err)

    @timed("tool search_profile")
    async def search_profile(self, text: str | int | float, kind: str = "any") -> str:
        """Search the data profile for tables, columns, metrics, business terms or values matching
        a phrase. Use it for a phrase the context does not cover, or with other words (English or
        Vietnamese, a synonym, a shorter phrase).

        Args:
            text: the words to look for, as in the question or in English.
            kind: what to look for: any, table, column, metric, term or value. Use value for a
                specific name or code that would be stored in a column.
        """
        cat, h = self.cat, self.h
        text = str(text)
        kind = kind if kind in _KINDS else "any"
        role = "value" if kind == "value" else "subject"
        kw = Keywords(phrases=[KeyPhrase(text=text, english=text, role=role)], time_phrases=[])
        r = await retrieve(text, kw, cat, self.searcher, self.scope)
        lines: list[str] = []
        if kind in ("any", "table"):
            lines += [f"table {h.of(t)} — “{cat.tables[t].display_name}”" for t in r.tables[:_MAX_LINES]]
        if kind in ("any", "metric"):
            lines += ["metric " + render_metric(m, h)[0] for m in r.metrics[:_MAX_LINES]]
        if kind in ("any", "term"):
            lines += ["term " + render_term(g, h) for g in r.glossary[:_MAX_LINES]]
        if kind in ("any", "column"):
            best = sorted(r.columns.items(), key=lambda kv: -kv[1])[:_MAX_LINES]
            lines += [f"column {render_column(cat.columns[c], h)}" for c, _ in best]
        if kind in ("any", "value"):
            for v in r.values[:_MAX_LINES]:
                label = f" ({v.label})" if v.label and v.label != v.value else ""
                lines.append(f"value {h.col_ref(v.column_id)} = {v.value}{label}" + ("" if v.exact else " (partial match)"))
        if not lines:
            others = [] if kind == "any" else [Run.of("search_profile", text=text, kind="any")]
            return self._guide(f"nothing found for {text!r} as {kind}", *others,
                               "search once more with other words (a synonym, English or Vietnamese, a shorter "
                               "phrase); if still nothing, it is not in the data")
        return "\n".join(lines)

    @timed("tool describe_table")
    async def describe_table(self, table: str, contains: str = "", page: int = 1) -> str:
        """Show one table in full: what one row is, its time column, the filters always applied, its
        columns (with value lists) and the tables it links to. A wide table comes in pages of 40
        columns; `contains` shows only the columns about some words.

        Args:
            table: a table name from the context or a search.
            contains: optional words; only columns whose name, display name, description, synonyms or
                values contain them are shown (e.g. a word of the question).
            page: which page of columns, for a table with more than 40 columns (1, 2, …).
        """
        cat, h = self.cat, self.h
        tid, problem = self._table(table)
        if tid is None:
            return problem
        name, every = h.of(tid), h.columns_of(tid)
        footer = ""
        if str(contains).strip():
            want = words(str(contains))
            hits = [c for c in every if _column_matches(c, want)]
            if not hits:
                return self._guide(f"no column of {name} is about {contains!r}",
                                   Run.of("search_profile", text=contains, kind="column"),
                                   f"try other words, or describe_table(table={name!r}) for every column")
            shown = hits[:DESCRIBE_PAGE]
            footer = (f"{len(hits)} of {len(every)} columns match {contains!r}"
                      + (f"; the first {DESCRIBE_PAGE} are shown, use more precise words" if len(hits) > DESCRIBE_PAGE
                         else ""))
        elif len(every) > DESCRIBE_PAGE:
            pages = -(-len(every) // DESCRIBE_PAGE)
            page = min(max(int(page or 1), 1), pages)
            start = (page - 1) * DESCRIBE_PAGE
            shown = every[start:start + DESCRIBE_PAGE]
            nxt = (f"describe_table(table={name!r}, page={page + 1})" if page < pages
                   else f"describe_table(table={name!r}, page=1)")
            footer = (f"page {page} of {pages}: columns {start + 1}–{start + len(shown)} of {len(every)}. "
                      f"Next: {nxt}, or describe_table(table={name!r}, contains='<words>') for the columns about "
                      "some words")
        else:
            shown = every
        lines = render_table(tid, h, columns=shown, rest_hint=" (names only)")
        links = []
        for j in cat.joins:
            if tid in (j.from_entity_id, j.to_entity_id) and j.from_entity_id in h.name_of and j.to_entity_id in h.name_of:
                pairs = " and ".join(f"{h.of(a)} = {h.of(b)}" for a, b in j.pairs)
                links.append(f"   {h.of(j.from_entity_id)} {j.cardinality} {h.of(j.to_entity_id)} ({pairs})")
        if links:
            lines += ["   links:", *links]
        if footer:
            lines.append(footer)
        return "\n".join(lines)

    @timed("tool list_values")
    async def list_values(self, column: str, contains: str | int | float | bool = "") -> str:
        """List the values recorded for a column (code = label), optionally only those whose code,
        label or synonyms contain some words. Use it to find the stored code of a value the
        question names.

        Args:
            column: a column as table.column.
            contains: optional words to look for in codes and labels; empty lists every value.
        """
        try:
            cid = self.h.resolve(column, "column")
        except UnknownName as err:
            return self._unknown(err)
        c = self.cat.columns[cid]
        items = c.profile.value_catalog
        if not items:
            return self._guide(f"{self.h.col_ref(cid)} has no recorded value list, so its values can't be checked here",
                               Run.of("search_profile", text=contains, kind="value") if contains else
                               "use the value as the question writes it")
        want = normalize(str(contains))
        shown = [v for v in items if not want or any(want in normalize(x) for x in (v.value, v.label or "", *v.synonyms))]
        if not shown:
            return self._guide(f"no value of {self.h.col_ref(cid)} matches {contains!r}",
                               Run.of("list_values", column=column, contains=""),
                               Run.of("search_profile", text=contains, kind="value"))
        complete = "complete list" if c.profile.value_catalog_complete else "partial list"
        rows = [f"{v.value}" + (f" = {v.label}" if v.label and v.label != v.value else "")
                + (f" (also: {', '.join(v.synonyms)})" if v.synonyms else "") for v in shown[:40]]
        more = f"\n(+{len(shown) - 40} more)" if len(shown) > 40 else ""
        return f"{self.h.col_ref(cid)} ({complete}):\n" + "\n".join(rows) + more

    @timed("tool join_path")
    async def join_path(self, from_table: str, to_table: str) -> str:
        """Show how two tables connect, step by step, and whether going from the first to the second
        repeats rows of the first (one row matching many rows), which would count them twice.

        Args:
            from_table: the table whose rows are counted or measured.
            to_table: the table used for grouping or filtering.
        """
        cat, h = self.cat, self.h
        (a, pa), (b, pb) = self._table(from_table), self._table(to_table)
        if a is None or b is None:
            return "; ".join(p for p in (pa, pb) if p)
        if a == b:
            return "same table: no join needed"
        path = _shortest(cat, h, a, b, safe_only=True) or _shortest(cat, h, a, b, safe_only=False)
        if path is None:
            return self._guide(f"no relationship connects {h.of(a)} and {h.of(b)}",
                               "these two tables can't be used together; pick another table that links to "
                               f"{h.of(a)}")
        return _describe_path(a, path, h)


def _repeats(j: Any, forward: bool) -> bool:
    return j.cardinality == "N:N" or (j.cardinality == "1:N" and forward)


def _shortest(cat: Catalog, h: Names, a: str, b: str, safe_only: bool) -> list[tuple[Any, bool]] | None:
    """Shortest path a → b; with safe_only, only through steps that match at most one row."""
    frontier: list[tuple[str, list[tuple[Any, bool]]]] = [(a, [])]
    seen = {a}
    while frontier:
        nxt = []
        for node, path in frontier:
            for j in sorted(cat.joins, key=lambda j: j.id):
                for forward, x, y in ((True, j.from_entity_id, j.to_entity_id), (False, j.to_entity_id, j.from_entity_id)):
                    if x != node or y in seen or y not in h.name_of or (safe_only and _repeats(j, forward)):
                        continue
                    step = [*path, (j, forward)]
                    if y == b:
                        return step
                    seen.add(y)
                    nxt.append((y, step))
        frontier = nxt
    return None


def _describe_path(start: str, path: list[tuple[Any, bool]], h: Names) -> str:
    lines, current, repeats = [], start, False
    for j, forward in path:
        nxt = j.to_entity_id if forward else j.from_entity_id
        many = _repeats(j, forward)
        repeats = repeats or many
        pairs = " and ".join(f"{h.of(a)} = {h.of(b)}" for a, b in j.pairs)
        lines.append(f"{h.of(current)} → {h.of(nxt)} ({pairs}): each row matches {'many rows' if many else 'at most one row'}")
        current = nxt
    verdict = ("repeats rows of the first table: measure with a metric of the other table, or use it only to "
               "pick keys" if repeats else "does not repeat rows: safe for grouping and filtering")
    return "\n".join([*lines, verdict])
