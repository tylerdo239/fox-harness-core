"""What the agents see: parts of the profile as compact text, named by real names.

Agents read and write the names people use: a table by its name (`conversations`, or its full
path when two sources have a table of that name), a column as `table.column` (a JSON field as
`workflow_nodes.config.is_intent_node`), a metric by its name, a business term by the term.
Names carry meaning, so agents pick better than with opaque codes. `Names.resolve` maps a name
back to its id (exact, ignoring case and quotes), per kind, and suggests close names when it
doesn't match. Only exposed, non-PII tables and columns are named or shown.
"""

import difflib
from dataclasses import dataclass
from typing import Literal

from src.data_profile.models import FilterOp, TypedFilter
from src.pipeline_v4.catalog import Catalog, Column
from src.pipeline_v4.retrieve import Retrieved
from src.pipeline_v4.timing import timed

MAX_VALUES_SHOWN = 15
_DATE_TYPES = ("DATE", "TIMESTAMP", "TIMESTAMPTZ", "DATETIME")
Kind = Literal["table", "column", "metric", "term"]


class UnknownName(KeyError):
    def __init__(self, name: str, kind: str, suggestions: list[str]) -> None:
        super().__init__(name)
        self.name, self.kind, self.suggestions = name, kind, suggestions

    def __str__(self) -> str:
        hint = f"; did you mean {', '.join(self.suggestions)}?" if self.suggestions else ""
        return f"{self.name!r} is not a known {self.kind}{hint}"


def _key(name: str) -> str:
    return " ".join(name.strip().strip("`'\"").lower().split())


class Names:
    def __init__(self, cat: Catalog) -> None:
        self.cat = cat
        self.by_kind: dict[str, dict[str, str]] = {k: {} for k in ("table", "column", "metric", "term")}
        self.name_of: dict[str, str] = {}
        tables = [t for t in cat.tables.values() if t.is_exposed and not t.is_pii]
        short_count: dict[str, int] = {}
        for t in tables:
            short_count[t.physical_name.lower()] = short_count.get(t.physical_name.lower(), 0) + 1
        for t in sorted(tables, key=lambda t: t.physical_path):
            name = t.physical_name if short_count[t.physical_name.lower()] == 1 else t.physical_path
            self._add("table", name, t.id)
            self.by_kind["table"].setdefault(_key(t.physical_path), t.id)  # the full path always works
            for c in self.columns_of(t.id):
                self._add("column", f"{name}.{c.physical_name}", c.id)
        for mid, m in sorted(cat.metrics.items(), key=lambda kv: kv[1].get("name") or ""):
            self._add("metric", m.get("name") or mid, mid)
        seen: dict[str, int] = {}
        for gid, g in sorted(cat.glossary.items(), key=lambda kv: kv[1].get("term") or ""):
            term = g.get("term") or gid
            seen[_key(term)] = seen.get(_key(term), 0) + 1
            self._add("term", term if seen[_key(term)] == 1 else f"{term} ({seen[_key(term)]})", gid)

    def _add(self, kind: str, name: str, real_id: str) -> None:
        self.by_kind[kind][_key(name)] = real_id
        self.name_of[real_id] = name

    def columns_of(self, table_id: str) -> list[Column]:
        cols = [c for c in self.cat.columns_of(table_id) if c.is_exposed and not c.is_pii]
        return sorted(cols, key=lambda c: (c.json_source is not None, c.physical_name))

    def resolve(self, name: str, kind: Kind | None = None) -> str:
        """The id of a name of this kind (any kind when None); UnknownName with close names."""
        key = _key(str(name))
        kinds = [kind] if kind else ["table", "column", "metric", "term"]
        for k in kinds:
            if key in self.by_kind[k]:
                return self.by_kind[k][key]
        pool = [self.name_of[i] for k in kinds for i in self.by_kind[k].values() if i in self.name_of]
        close = difflib.get_close_matches(str(name).strip(), list(dict.fromkeys(pool)), n=3, cutoff=0.6)
        raise UnknownName(str(name), kind or "name", close)

    def of(self, real_id: str) -> str:
        return self.name_of.get(real_id, "?")

    def col_ref(self, column_id: str) -> str:
        return self.of(column_id)


@dataclass
class AgentContext:
    text: str
    names: Names

    def resolve(self, name: str, kind: Kind | None = None) -> str:
        return self.names.resolve(name, kind)


# ── rendering (shared with the agent tools) ──

def filter_text(f: TypedFilter, cat: Catalog) -> str:
    c = cat.columns.get(f.column_id)
    name = c.physical_name if c else "?"
    if f.op == FilterOp.IS_NULL:
        return f"{name} is empty"
    if f.op == FilterOp.IS_NOT_NULL:
        return f"{name} is not empty"
    return f"{name} {f.op.value} {', '.join(map(str, f.values))}"


def one_line(text: str | None, limit: int = 160) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


WIDE_TABLE = 40   # above this many columns, the context shows only the columns that matter


def essential_columns(tid: str, h: Names, wanted: set[str] | None = None) -> set[str]:
    """Columns of a table an agent needs whatever the question: its keys, name, time and snapshot
    columns, columns linking it to other tables or used by its always-applied filters, and `wanted`
    (columns the question's words matched)."""
    cat = h.cat
    p = cat.tables[tid].profile
    own = {c.id for c in h.columns_of(tid)}
    ids = {*p.grain_key_column_ids, p.label_column_id, p.time_column_id, p.snapshot_column_id}
    ids |= {f.column_id for f in p.default_filters}
    ids |= {c for j in cat.joins for a, b in j.pairs for c in (a, b)}
    return (ids | (wanted or set())) & own


def render_table(tid: str, h: Names, *, lookup: bool = False, matched: dict[str, list[str]] | None = None,
                 extra_columns: set[str] | None = None, columns: list[Column] | None = None,
                 rest_hint: str = "") -> list[str]:
    """A table with its columns. Lookup tables show only keys, the name and grouping columns. A wide
    table (more than WIDE_TABLE columns) shows only its essential columns and the question's matches;
    the others are listed by name on one line. `columns`: exactly these (describe_table's pages)."""
    cat = h.cat
    t = cat.tables[tid]
    p = t.profile
    kind = p.table_kind.value if p.table_kind else "kind not set"
    note = " (lookup: joined for names and groupings)" if lookup else ""
    lines = [f"{h.of(tid)} — “{t.display_name}” [{kind}]{note}"]
    if t.grain_description:
        lines.append(f"   one row = {one_line(t.grain_description)}")
    if t.description:
        lines.append(f"   {one_line(t.description)}")
    if p.time_column_id and p.time_column_id in h.name_of:
        tz = f" (business time {p.business_tz})" if p.business_tz else ""
        lines.append(f"   main time column: {h.col_ref(p.time_column_id)}{tz}")
    if p.default_filters:
        lines.append("   always applied: " + " and ".join(filter_text(f, cat) for f in p.default_filters))
    for caveat in p.caveats[:3]:
        lines.append(f"   caveat: {one_line(caveat)}")
    every = h.columns_of(tid)
    cols = every
    if columns is not None:
        cols = columns
    elif lookup:
        keep = extra_columns or set()
        cols = [c for c in cols if c.id in p.grain_key_column_ids or c.id == p.label_column_id
                or c.role in ("key", "dimension") or c.id in keep or c.profile.value_catalog]
    elif len(every) > WIDE_TABLE:
        keep = essential_columns(tid, h, {*(extra_columns or set()), *(matched or {})})
        cols = [c for c in every if c.id in keep]
    lines.append(f"   columns ({len(cols)} of {len(every)}):" if len(cols) < len(every) else "   columns:")
    lines += ["     " + render_column(c, h, (matched or {}).get(c.id, [])) for c in cols]
    shown = {c.id for c in cols}
    rest = [c.physical_name for c in every if c.id not in shown]
    if rest and not lookup:
        lines.append(f"   {len(rest)} more columns{rest_hint}: {', '.join(rest)}")
    return lines


def render_column(c: Column, h: Names, matched: list[str] | None = None) -> str:
    cat = h.cat
    t = cat.tables[c.entity_id]
    p = c.profile
    parts = [h.of(c.id), c.data_type]
    if c.role:
        parts.append(c.role)
    if c.semantic_type:
        parts.append(c.semantic_type)
    if c.display_name and c.display_name != c.physical_name:
        parts.append(f"“{c.display_name}”")
    flags = []
    if c.id in t.profile.grain_key_column_ids:
        flags.append("identifies the row")
    if c.id == t.profile.label_column_id:
        flags.append("name shown for the row")
    if c.json_source:
        flags.append(f"JSON field in {c.json_source}")
    if p.unit:
        flags.append(f"unit {p.unit}")
    if p.date_format and c.data_type not in _DATE_TYPES:
        flags.append(f"date stored as text {p.date_format}")
    for j in cat.joins:
        for a, b in j.pairs:
            other = b if a == c.id else a if b == c.id else None
            if other and other in h.name_of and cat.columns[other].entity_id != c.entity_id:
                flags.append(f"links to {h.of(other)}")
    line = " ".join(parts) + (f" ({'; '.join(flags)})" if flags else "")
    if c.description:
        line += f" — {one_line(c.description, 90)}"
    catalog = p.value_catalog
    if catalog:
        shown = catalog if len(catalog) <= MAX_VALUES_SHOWN else [v for v in catalog if v.value in (matched or [])]
        items = ", ".join(f"{v.value}={v.label}" if v.label and v.label != v.value else v.value for v in shown)
        more = "" if len(shown) == len(catalog) else f" (+{len(catalog) - len(shown)} more)"
        kind = "all values" if p.value_catalog_complete else "some values"
        line += f" · {kind}: {items}{more}"
    return line


def render_links(table_ids: list[str], h: Names) -> list[str]:
    cat = h.cat
    wanted = set(table_ids)
    out = []
    for j in cat.joins:
        if j.from_entity_id in wanted and j.to_entity_id in wanted:
            pairs = " and ".join(f"{h.of(a)} = {h.of(b)}" for a, b in j.pairs)
            out.append(f"{h.of(j.from_entity_id)} {j.cardinality} {h.of(j.to_entity_id)} ({pairs})")
    return out


def render_metric(mid: str, h: Names) -> list[str]:
    cat = h.cat
    m = cat.metrics[mid]
    lines = [f"{h.of(mid)} — “{m.get('display_name') or m['name']}”: {_metric_formula(m, h)}"
             + (f" [{m['unit']}]" if m.get("unit") else "")]
    if m.get("description"):
        lines.append(f"   {one_line(m['description'])}")
    return lines


def render_term(gid: str, h: Names) -> str:
    cat = h.cat
    g = cat.glossary[gid]
    kind = g.get("kind")
    where = ""
    if kind == "segment" and g.get("entity_id") in h.name_of:
        conds = " and ".join(filter_text(TypedFilter.model_validate(f), cat) for f in g.get("filters") or [])
        where = f" (segment of {h.of(g['entity_id'])}: {conds})"
    elif kind == "metric" and g.get("metric_id") in h.name_of:
        where = f" (means metric {h.of(g['metric_id'])})"
    return f"“{h.of(gid)}” [{kind}]{where}: {one_line(g.get('definition'))}"


def _metric_formula(m: dict, h: Names) -> str:
    cat = h.cat
    if m.get("kind") == "ratio":
        num, den = (h.of(m.get(s) or "") for s in ("numerator_metric_id", "denominator_metric_id"))
        scale = m.get("ratio_scale") or 1
        return f"ratio {num} / {den}" + (f" × {scale:g}" if scale != 1 else "")
    t = cat.tables.get(m.get("entity_id") or "")
    col = cat.columns.get(m.get("column_id") or "")
    what = f"{m.get('aggregation')}({col.physical_name})" if col else f"{m.get('aggregation')}(*)"
    text = f"{what} of {h.of(t.id) if t else '?'}"
    conds = [filter_text(TypedFilter.model_validate(f), cat) for f in m.get("filters") or []]
    if conds:
        text += " where " + " and ".join(conds)
    if not m.get("use_table_default_filters", True):
        text += " (ignores the table's always-applied filters)"
    if m.get("builtin"):
        text += " (built-in row count)"
    return text


@timed("build context")
async def build_context(r: Retrieved, cat: Catalog, names: Names | None = None) -> AgentContext:
    h = names or Names(cat)
    matched: dict[str, list[str]] = {}
    for v in r.values:
        matched.setdefault(v.column_id, []).append(v.value)
    lines = ["## Tables"]
    for tid in r.all_tables:
        lines += render_table(tid, h, lookup=tid in r.lookups, matched=matched, extra_columns=set(r.columns),
                              rest_hint=f" (names only; describe_table(table='{h.of(tid)}', contains='<words>') "
                                        "shows them in full)")
    links = render_links(r.all_tables, h)
    if links:
        lines += ["", "## Links (one row on the left has N rows on the right for 1:N)", *links]
    lines += ["", "## Metrics"]
    if not r.metrics:
        lines.append("(no saved metric matches; say so instead of inventing one)")
    for mid in r.metrics:
        lines += render_metric(mid, h)
    if r.glossary:
        lines += ["", "## Business terms", *(render_term(gid, h) for gid in r.glossary)]
    if r.values:
        lines += ["", "## Values the question mentions"]
        for v in r.values:
            label = f" ({v.label})" if v.label and v.label != v.value else ""
            how = "" if v.exact else " (similar, check)"
            lines.append(f"“{v.matched}” → {h.col_ref(v.column_id)} = {v.value}{label}{how}")
    return AgentContext(text="\n".join(lines), names=h)
