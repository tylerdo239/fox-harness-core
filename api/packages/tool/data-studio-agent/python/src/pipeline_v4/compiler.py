"""QuerySpec + Catalog → one read-only Dremio SQL statement.

Layout (aggregate shape):
  set_*    one CTE per key set (sub-question) used by `set_filters`: col IN (SELECT key FROM set_x)
  g1..gN   one CTE per measure group (same table, same metric filters, same time column),
           aggregated to the requested dimensions; periods become CASE WHEN inside the aggregate
  spine    the union of the groups' dimension keys (only when there are several groups)
  calc     derived values computed across rows (windows), when having or rank must filter on them
  final    joins the groups, adds derived values, having, ranking, order and limit
A single group with nothing on top is emitted as one flat SELECT.

Two-level questions (`per`): the layers above are built per key (e.g. per customer) into the CTE
"per", then summarized (avg, median, …) and/or grouped into value ranges (`buckets`).

Every identifier is quoted and every value is a typed literal. JSON fields become
TRY_CONVERT_FROM(... AS ROW(...)); the read-only check runs on a placeholder version because the
parser doesn't know that syntax. Nothing here reads MongoDB or calls Dremio.
"""

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field

from src.data_profile.models import NO_VALUE_OPS, FilterOp, TableKind, TypedFilter
from src.pipeline_v4.catalog import Catalog, Column, Join, Table
from src.pipeline_v4.spec import (
    TIME_OPS,
    WINDOW_OPS,
    Derived,
    Dimension,
    KeySet,
    Period,
    QuerySpec,
    SetFilter,
)
from src.pipeline_v4.timing import timed
from src.services.sql_safety import check_read_only_sql

Owner = Literal["metric", "dimension", "filter", "period", "rank", "detail", "spec"]

_NUMERIC = {"INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT", "DECIMAL", "DOUBLE", "FLOAT", "NUMERIC"}
_TIMESTAMP = {"TIMESTAMP", "TIMESTAMPTZ", "DATETIME"}
_DATE_LIKE = {"DATE", *_TIMESTAMP}
_TEXT_DATE_FORMATS = {"YYYYMMDD": "%Y%m%d", "YYYY-MM-DD": "%Y-%m-%d", "YYYYMM": "%Y%m", "YYYY-MM": "%Y-%m", "YYYY": "%Y"}
_GRAIN_SQL = {"day": "DAY", "week": "WEEK", "month": "MONTH", "quarter": "QUARTER", "year": "YEAR"}
MAX_ROWS = 1000
DETAIL_DEFAULT_LIMIT = 100


class SpecError(BaseModel):
    owner: Owner                # which agent filled the slot (errors go back to it)
    field: str
    message: str
    suggestions: list[str] = Field(default_factory=list)


class CompileError(Exception):
    def __init__(self, errors: list[SpecError]) -> None:
        super().__init__("; ".join(f"{e.field}: {e.message}" for e in errors))
        self.errors = errors


class OutputColumn(BaseModel):
    name: str
    kind: Literal["dimension", "label", "metric", "derived", "column"]
    column_id: str | None = None
    metric_id: str | None = None
    unit: str | None = None
    time_grain: str | None = None


class Compiled(BaseModel):
    sql: str
    shape: str
    columns: list[OutputColumn]
    tables: list[str]
    assumptions: list[str] = Field(default_factory=list)


# ── SQL text helpers ──

def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _path(physical_path: str) -> str:
    return ".".join(_q(p) for p in physical_path.split("."))


def _string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _literal(value: Any, data_type: str) -> str:
    if data_type in _NUMERIC:
        number = float(str(value).replace(",", "."))
        return str(int(number)) if number.is_integer() else repr(number)
    if data_type == "BOOLEAN":
        text = str(value).strip().lower()
        if text in ("1", "true", "yes", "có"):
            return "TRUE"
        if text in ("0", "false", "no", "không"):
            return "FALSE"
        raise ValueError(f"{value!r} is not true/false")
    return _string(str(value))


class _Placeholders:
    """JSON field expressions are swapped for placeholder identifiers during the read-only check."""

    def __init__(self) -> None:
        self.items: dict[str, str] = {}

    def register(self, real: str) -> str:
        for name, expr in self.items.items():
            if expr == real:
                return name
        name = f'"__json_field_{len(self.items)}__"'
        self.items[name] = real
        return name

    def finish(self, sql: str) -> str:
        for name, expr in self.items.items():
            sql = sql.replace(name, expr)
        return sql


# ── compiler ──

@dataclass
class _Measure:
    name: str               # output name (may be internal "__x__num")
    metric_id: str
    metric: dict[str, Any]
    period: str | None
    hidden: bool = False


@dataclass
class _Group:
    entity_id: str
    filters: list[TypedFilter]
    use_defaults: bool
    time_column_id: str | None
    measures: list[_Measure] = field(default_factory=list)


class _Compiler:
    def __init__(self, spec: QuerySpec, cat: Catalog) -> None:
        self.spec = spec
        self.cat = cat
        self.errors: list[SpecError] = []
        self.assumptions: list[str] = []
        self.ph = _Placeholders()
        self.tables_used: set[str] = set()

    def err(self, owner: Owner, fld: str, message: str, suggestions: list[str] | None = None) -> None:
        self.errors.append(SpecError(owner=owner, field=fld, message=message, suggestions=suggestions or []))

    # ── columns and values ──

    def column(self, column_id: str, owner: Owner, fld: str) -> Column | None:
        col = self.cat.columns.get(column_id)
        if col is None or col.entity_id not in self.cat.tables:
            self.err(owner, fld, "unknown column")
            return None
        if col.is_pii:
            self.err(owner, fld, f"{col.physical_name} is personal data and can't be used")
            return None
        return col

    def col_expr(self, col: Column, alias: str) -> str:
        if not col.json_source:
            return f"{_q(alias)}.{_q(col.physical_name)}"
        parts = (col.json_path or "").split(".")
        row_type = col.data_type
        for part in reversed(parts):
            row_type = f"ROW({_q(part)} {row_type})"
        access = "".join(f".{_q(p)}" for p in parts)
        return self.ph.register(f"(TRY_CONVERT_FROM({_q(alias)}.{_q(col.json_source)} AS {row_type})){access}")

    def check_values(self, f: TypedFilter, col: Column, owner: Owner, fld: str) -> None:
        if f.op in NO_VALUE_OPS:
            if f.values:
                self.err(owner, fld, f"'{f.op}' takes no value")
            return
        if f.op in (FilterOp.IN, FilterOp.NOT_IN):
            if not f.values:
                self.err(owner, fld, f"'{f.op}' needs at least one value")
        elif len(f.values) != 1:
            self.err(owner, fld, f"'{f.op}' needs exactly one value")
        cp = col.profile
        if cp.value_catalog_complete and cp.value_catalog:
            known = {v.value for v in cp.value_catalog}
            labels = {(v.label or "").lower(): v.value for v in cp.value_catalog}
            for v in f.values:
                if str(v) not in known:
                    hint = labels.get(str(v).lower())
                    self.err(owner, fld, f"{v!r} is not a value of {col.physical_name}",
                             [f"{hint} (label: {v})"] if hint else sorted(known)[:20])
        for v in f.values:
            try:
                _literal(v, col.data_type)
            except ValueError as exc:
                self.err(owner, fld, f"{col.physical_name}: {exc}")

    def filter_sql(self, f: TypedFilter, col: Column, alias: str) -> str:
        expr = self.col_expr(col, alias)
        if f.op == FilterOp.IS_NULL:
            return f"{expr} IS NULL"
        if f.op == FilterOp.IS_NOT_NULL:
            return f"{expr} IS NOT NULL"
        values = [_literal(v, col.data_type) for v in f.values]
        if f.op in (FilterOp.IN, FilterOp.NOT_IN):
            return f"{expr} {'NOT IN' if f.op == FilterOp.NOT_IN else 'IN'} ({', '.join(values)})"
        op = "<>" if f.op == FilterOp.NEQ else f.op.value
        return f"{expr} {op} {values[0]}"

    # ── time ──

    def zone(self, name: str | None) -> ZoneInfo | None:
        if not name:
            return None
        try:
            return ZoneInfo(name)
        except ZoneInfoNotFoundError:
            self.err("period", "time_zone", f"unknown time zone {name!r} in the table profile")
            return None

    def period_sql(self, col: Column, alias: str, period: Period, table: Table) -> str | None:
        expr = self.col_expr(col, alias)
        start, end = period.start, period.end
        if col.data_type == "DATE":
            return f"{expr} >= DATE '{start.isoformat()}' AND {expr} < DATE '{end.isoformat()}'"
        if col.data_type in _TIMESTAMP:
            bz, sz = self.zone(table.profile.business_tz), self.zone(table.profile.storage_tz)

            def stamp(d: date) -> str:
                moment = datetime(d.year, d.month, d.day, tzinfo=bz) if bz else datetime(d.year, d.month, d.day)
                if bz and sz:
                    moment = moment.astimezone(sz)
                return moment.strftime("%Y-%m-%d %H:%M:%S")

            return f"{expr} >= TIMESTAMP '{stamp(start)}' AND {expr} < TIMESTAMP '{stamp(end)}'"
        fmt = _TEXT_DATE_FORMATS.get(col.profile.date_format or "")
        if fmt is None:
            self.err("period", col.physical_name, f"{col.physical_name} is {col.data_type}: set its date format to filter by period")
            return None
        lo, hi = start.strftime(fmt), end.strftime(fmt)
        if col.data_type in _NUMERIC:
            return f"{expr} >= {lo} AND {expr} < {hi}"
        return f"{expr} >= {_string(lo)} AND {expr} < {_string(hi)}"

    def grain_expr(self, col: Column, alias: str, grain: str, table: Table) -> str | None:
        expr = self.col_expr(col, alias)
        unit = _GRAIN_SQL[grain]
        if col.data_type == "DATE":
            return f"DATE_TRUNC('{unit}', {expr})"
        if col.data_type in _TIMESTAMP:
            bz, sz = table.profile.business_tz, table.profile.storage_tz
            if bz and sz and bz != sz:
                expr = f"CONVERT_TIMEZONE({_string(sz)}, {_string(bz)}, {expr})"
            return f"DATE_TRUNC('{unit}', {expr})"
        self.err("dimension", col.physical_name, f"{col.physical_name} is {col.data_type}: grouping by {grain} needs a DATE or TIMESTAMP column")
        return None

    # ── joins ──

    def join_path(self, start: str, target: str) -> list[tuple[Join, bool]] | None:
        """Shortest path start → target as (join, forward) steps; forward = traversed from → to.

        Paths whose every step matches at most one row are searched first: two paths can have the
        same length while only one repeats rows (workflow_nodes → conversations → agents vs
        workflow_nodes → workflows → agents). Any path is returned only when no safe one exists,
        so the caller can say which join would repeat rows."""
        if start == target:
            return []
        return self._shortest(start, target, safe_only=True) or self._shortest(start, target, safe_only=False)

    def _shortest(self, start: str, target: str, safe_only: bool) -> list[tuple[Join, bool]] | None:
        frontier: list[tuple[str, list[tuple[Join, bool]]]] = [(start, [])]
        seen = {start}
        while frontier:
            nxt = []
            for node, path in frontier:
                for j in sorted(self.cat.joins, key=lambda j: j.id):
                    for forward, a, b in ((True, j.from_entity_id, j.to_entity_id), (False, j.to_entity_id, j.from_entity_id)):
                        if a != node or b in seen or (safe_only and self.expands(j, forward)):
                            continue
                        step = [*path, (j, forward)]
                        if b == target:
                            return step
                        seen.add(b)
                        nxt.append((b, step))
            frontier = nxt
        return None

    @staticmethod
    def expands(j: Join, forward: bool) -> bool:
        if j.cardinality == "N:N":
            return True
        return j.cardinality == "1:N" and forward

    def from_clause(self, home: str, needed: set[str], owner_of: dict[str, tuple[Owner, str]]) -> tuple[str, dict[str, str]] | None:
        """FROM … JOIN … reaching every needed table from the home table; aliases t0, t1…"""
        home_table = self.cat.tables[home]
        aliases = {home: "t0"}
        sql = f"{_path(home_table.physical_path)} AS {_q('t0')}"
        self.tables_used.add(home)
        ok = True
        for target in sorted(needed - {home}):
            path = self.join_path(home, target)
            owner, fld = owner_of.get(target, ("dimension", target))
            if path is None:
                self.err(owner, fld, f"{self.cat.tables[target].physical_path} can't be reached from "
                         f"{home_table.physical_path}: add a relationship between them")
                ok = False
                continue
            current = home
            for j, forward in path:
                nxt = j.to_entity_id if forward else j.from_entity_id
                if self.expands(j, forward):
                    self.err(owner, fld, f"joining {self.cat.tables[current].physical_name} to "
                             f"{self.cat.tables[nxt].physical_name} repeats rows (one to many), so the numbers "
                             f"would be counted more than once; use a metric on {self.cat.tables[nxt].physical_name} instead")
                    ok = False
                    break
                if nxt not in aliases:
                    aliases[nxt] = f"t{len(aliases)}"
                    conds = []
                    for a, b in j.pairs:
                        here, there = (a, b) if forward else (b, a)
                        ca, cb = self.cat.columns.get(here), self.cat.columns.get(there)
                        if ca is None or cb is None:
                            continue
                        conds.append(f"{self.col_expr(ca, aliases[current])} = {self.col_expr(cb, aliases[nxt])}")
                    if not conds:
                        self.err(owner, fld, f"the relationship to {self.cat.tables[nxt].physical_name} has no key columns")
                        ok = False
                        break
                    rate = j.profile.match_rate
                    kind = "INNER" if j.join_type_default == "inner" and (rate is None or rate >= 0.995) else "LEFT"
                    sql += f" {kind} JOIN {_path(self.cat.tables[nxt].physical_path)} AS {_q(aliases[nxt])} ON {' AND '.join(conds)}"
                    self.tables_used.add(nxt)
                current = nxt
        return (sql, aliases) if ok else None

    # ── validation of shared parts ──

    def segment_filters(self, segment_ids: list[str], fld: str) -> list[TypedFilter]:
        out = []
        for i, sid in enumerate(segment_ids):
            term = self.cat.glossary.get(sid)
            if term is None or term.get("kind") != "segment":
                self.err("filter", f"{fld}[{i}]", "unknown segment (glossary term of kind segment)")
                continue
            for f in term.get("filters") or []:
                out.append(TypedFilter.model_validate(f))
            self.assumptions.append(f"“{term['term']}”: {term.get('definition') or ''}".strip())
        return out

    def checked_filters(self, filters: list[TypedFilter] | None = None, segments: list[str] | None = None,
                        prefix: str = "") -> list[tuple[TypedFilter, Column]]:
        filters = self.spec.filters if filters is None else filters
        segments = self.spec.segments if segments is None else segments
        result = []
        for i, f in enumerate([*filters, *self.segment_filters(segments, f"{prefix}segments")]):
            col = self.column(f.column_id, "filter", f"{prefix}filters[{i}]")
            if col is not None:
                self.check_values(f, col, "filter", f"{prefix}filters[{i}]")
                result.append((f, col))
        return result

    def conflict_error(self, applied: list[tuple[str, TypedFilter]], owner: Owner, fld: str) -> bool:
        clash = _conflict(applied)
        if clash:
            (src_a, fa), (src_b, fb) = clash
            cols = self.cat.columns
            self.err("metric" if "metric" in (src_a, src_b) else owner, fld,
                     f"{src_a} filter “{_describe(fa, cols)}” and {src_b} filter “{_describe(fb, cols)}” "
                     "can never both be true, so the result is always empty or 0")
        return clash is not None

    # ── key sets (sub-questions) ──

    def checked_set_filters(self) -> list[tuple[SetFilter, Column]]:
        out = []
        for i, sf in enumerate(self.spec.set_filters):
            col = self.column(sf.column_id, "filter", f"set_filters[{i}]")
            if sf.set not in self.spec.sets:
                self.err("filter", f"set_filters[{i}]", f"no set named {sf.set!r}", sorted(self.spec.sets))
            elif col is not None:
                out.append((sf, col))
        return out

    def set_filter_sql(self, sf: SetFilter, col: Column, alias: str) -> str:
        neg = "NOT IN" if sf.op == "not_in_set" else "IN"
        return f"{self.col_expr(col, alias)} {neg} (SELECT {_q('key')} FROM {_q('set_' + sf.set)})"

    def build_sets(self) -> list[tuple[str, str]]:
        """One CTE per set that a set filter uses."""
        used = {sf.set for sf in self.spec.set_filters}
        ctes = []
        for name, ks in self.spec.sets.items():
            if name not in used:
                self.err("filter", f"sets.{name}", f"set {name!r} is not used by any set filter")
                continue
            sql = self.set_sql(name, ks)
            if sql:
                ctes.append((f"set_{name}", sql))
        return ctes

    def set_sql(self, name: str, ks: KeySet) -> str | None:
        """SELECT DISTINCT key … WHERE …, or GROUP BY key HAVING <metric> … when the set has conditions.
        Keys are never NULL, so NOT IN stays correct."""
        fld = f"sets.{name}"
        key = self.column(ks.key_column_id, "filter", f"{fld}.key_column_id")
        metric = None
        if ks.metric_id:
            metric = self.cat.metrics.get(ks.metric_id)
            if metric is None or metric.get("kind") == "ratio":
                self.err("filter", f"{fld}.metric_id", "pick an aggregate metric (not a ratio) for the set")
                return None
        filters = self.checked_filters(ks.filters, ks.segments, f"{fld}.")
        if key is None:
            return None
        home = metric["entity_id"] if metric else key.entity_id
        if home not in self.cat.tables:
            self.err("filter", f"{fld}.metric_id", "the metric's table no longer exists")
            return None
        table = self.cat.tables[home]
        owner_of: dict[str, tuple[Owner, str]] = {key.entity_id: ("filter", f"{fld}.key_column_id")}
        for _, c in filters:
            owner_of.setdefault(c.entity_id, ("filter", f"{fld}.filters"))
        fc = self.from_clause(home, {key.entity_id} | {c.entity_id for _, c in filters}, owner_of)
        if fc is None:
            return None
        from_sql, aliases = fc
        cols = self.cat.columns
        applied: list[tuple[str, TypedFilter]] = []
        if metric:
            applied += [("metric", TypedFilter.model_validate(f)) for f in metric.get("filters") or []]
        if ks.include_default_filters and (metric is None or metric.get("use_table_default_filters", True)):
            applied += [("table default", f) for f in table.profile.default_filters]
            if table.profile.default_filters:
                self.assumptions.append(f"{table.physical_name}: only rows where " + " and ".join(
                    _describe(f, cols) for f in table.profile.default_filters))
        if self.conflict_error([*applied, *(("question", f) for f, c in filters if c.entity_id == home)],
                               "filter", fld):
            return None
        where = [self.filter_sql(f, cols[f.column_id], "t0") for _, f in applied if f.column_id in cols]
        where += [self.filter_sql(f, c, aliases[c.entity_id]) for f, c in filters]
        if ks.period:
            p = self.spec.periods.get(ks.period)
            time_col = cols.get((metric or {}).get("time_column_id") or table.profile.time_column_id or "")
            if p is None:
                self.err("period", f"{fld}.period", f"no period named {ks.period!r}")
            elif time_col is None:
                self.err("period", f"{fld}.period", f"{table.physical_name} has no time column")
            else:
                cond = self.period_sql(time_col, "t0", p, table)
                if cond:
                    where.append(cond)
        kexpr = self.col_expr(key, aliases[key.entity_id])
        where.append(f"{kexpr} IS NOT NULL")
        sql = (f"SELECT {'' if ks.having else 'DISTINCT '}{kexpr} AS {_q('key')} FROM {from_sql} WHERE "
               + " AND ".join(f"({w})" for w in where))
        if ks.having and metric:
            agg = self.measure_sql(_Measure(name, metric["_id"], metric, None), "t0", None, cols)
            sql += f" GROUP BY {kexpr} HAVING " + " AND ".join(
                f"{agg} {'<>' if h.op == '!=' else h.op} {h.value:g}" for h in ks.having)
        return sql

    # ── aggregate ──

    def measures(self) -> list[_Measure]:
        out: list[_Measure] = []
        self.derived: list[Derived] = list(self.spec.derived)
        names = set()
        for i, ref in enumerate(self.spec.metrics):
            if ref.name in names:
                self.err("metric", f"metrics[{i}].name", f"{ref.name!r} is used twice")
            names.add(ref.name)
            m = self.cat.metrics.get(ref.metric_id)
            if m is None:
                self.err("metric", f"metrics[{i}]", "unknown metric")
                continue
            if ref.period is not None and ref.period not in self.spec.periods:
                self.err("period", f"metrics[{i}].period", f"no period named {ref.period!r}")
            if m.get("kind") == "ratio":
                parts = []
                for side in ("numerator_metric_id", "denominator_metric_id"):
                    sub = self.cat.metrics.get(m.get(side) or "")
                    if sub is None or sub.get("kind") == "ratio":
                        self.err("metric", f"metrics[{i}]", f"{m['name']}: its {side.split('_')[0]} must be an aggregate metric")
                        break
                    parts.append(_Measure(f"__{ref.name}__{side[:3]}", sub["_id"], sub, ref.period, hidden=True))
                else:
                    out += parts
                    self.derived.insert(0, Derived(name=ref.name, op="ratio", args=[p.name for p in parts],
                                                   scale=float(m.get("ratio_scale") or 1)))
                    self.ratio_units = getattr(self, "ratio_units", {})
                    self.ratio_units[ref.name] = (m.get("unit"), ref.metric_id)
                continue
            out.append(_Measure(ref.name, ref.metric_id, m, ref.period))
        return out

    def measure_sql(self, ms: _Measure, alias: str, period_cond: str | None, cols: dict[str, Column]) -> str | None:
        m = ms.metric
        agg = m.get("aggregation")
        target = cols.get(m.get("column_id") or "")
        if agg != "count" and target is None:
            self.err("metric", ms.name, f"{m['name']}: its column no longer exists")
            return None
        expr = self.col_expr(target, alias) if target else None
        if period_cond:
            inner = f"CASE WHEN {period_cond} THEN {expr if expr else '1'} END"
        else:
            inner = expr or "*"
        if agg == "count_distinct":
            return f"COUNT(DISTINCT {inner})"
        if agg == "count":
            return f"COUNT({inner})"
        return f"{str(agg).upper()}({inner})"

    def compile_aggregate(self) -> Compiled | None:
        if self.spec.detail_period:
            self.err("period", "detail_period", "detail_period is only for row lists (shape detail); "
                     "for numbers, give each metric its period instead")
        parts = self.compile_per() if self.spec.per else self.aggregate_layers()
        if parts is None or self.errors:
            return None
        ctes, body, out_cols = parts
        return self.finish(_with(ctes, body), "aggregate", out_cols)

    def aggregate_layers(self, nested: bool = False) -> tuple[list[tuple[str, str]], str, list[OutputColumn]] | None:
        """CTEs + final SELECT. nested=True (inside `per`) leaves out order and limit."""
        spec = self.spec
        if not spec.metrics:
            self.err("metric", "metrics", "pick at least one metric")
            return None
        measures = self.measures()
        filters = self.checked_filters()
        set_filters = self.checked_set_filters()
        set_ctes = self.build_sets()

        # dimensions
        dims: list[tuple[Column, str | None, str]] = []  # (column, grain, output name)
        used_names: set[str] = set()
        for i, d in enumerate(spec.dimensions):
            col = self.column(d.column_id, "dimension", f"dimensions[{i}]")
            if col is None:
                continue
            if d.time_grain and col.data_type not in _DATE_LIKE:
                self.err("dimension", f"dimensions[{i}]", f"{col.physical_name} is {col.data_type}: it can't be grouped by {d.time_grain}")
            name = col.physical_name.replace(".", "_") + (f"_{d.time_grain}" if d.time_grain else "")
            if name in used_names:
                name = f"{self.cat.tables[col.entity_id].physical_name}_{name}"
            used_names.add(name)
            dims.append((col, d.time_grain, name))
        time_dim = next((n for _, g, n in dims if g), None)

        # groups
        groups: dict[str, _Group] = {}
        for ms in measures:
            m = ms.metric
            eid = m.get("entity_id")
            if eid not in self.cat.tables:
                self.err("metric", ms.name, f"{m['name']}: its table no longer exists")
                continue
            table = self.cat.tables[eid]
            time_col = m.get("time_column_id") or table.profile.time_column_id
            if table.profile.table_kind == TableKind.SNAPSHOT and table.profile.snapshot_column_id:
                time_col = table.profile.snapshot_column_id
            if ms.period and not time_col:
                self.err("period", ms.name, f"{table.physical_path} has no time column, so {m['name']} can't be limited to a period")
            mf = [TypedFilter.model_validate(f) for f in m.get("filters") or []]
            key = json.dumps([eid, [f.model_dump(mode="json") for f in mf], bool(m.get("use_table_default_filters", True)), time_col], sort_keys=True)
            groups.setdefault(key, _Group(eid, mf, bool(m.get("use_table_default_filters", True)), time_col)).measures.append(ms)
        if self.errors:
            return None

        # derived values may use metrics and earlier derived values; window values can't be nested
        known = {ms.name for ms in measures}
        windowed: set[str] = set()
        for i, d in enumerate(self.derived):
            for a in d.args:
                if a not in known:
                    self.err("metric", f"derived[{i}]", f"unknown argument {a!r} (use a metric or an earlier derived value)")
            if d.op in TIME_OPS and time_dim is None:
                self.err("metric", f"derived[{i}]", f"{d.op} needs a dimension grouped by day, week, month, quarter or year")
            if d.op in WINDOW_OPS:
                for a in d.args:
                    if a in windowed:
                        self.err("metric", f"derived[{i}]", f"{d.op} can't be applied to {a!r}, which is itself "
                                 "computed across rows; apply it to the metric instead")
                windowed.add(d.name)
            elif any(a in windowed for a in d.args):
                windowed.add(d.name)
            known.add(d.name)
        names = known
        for i, h in enumerate(spec.having):
            if h.field not in names:
                self.err("rank", f"having[{i}]", f"unknown field {h.field!r}")
        if spec.rank and spec.rank.by not in names:
            self.err("rank", "rank.by", f"unknown field {spec.rank.by!r}")
        if self.errors:
            return None

        # one CTE per group
        dim_names = [n for _, _, n in dims]
        ctes: list[tuple[str, str]] = []
        label_cols: list[tuple[str, str]] = []  # (output name, group-level alias)
        cols = self.cat.columns
        for gi, g in enumerate(groups.values(), start=1):
            table = self.cat.tables[g.entity_id]
            needed = ({c.entity_id for c, _, _ in dims} | {c.entity_id for _, c in filters}
                      | {c.entity_id for _, c in set_filters})
            owner_of: dict[str, tuple[Owner, str]] = {}
            for c, _, n in dims:
                owner_of.setdefault(c.entity_id, ("dimension", n))
            for _, c in [*filters, *set_filters]:
                owner_of.setdefault(c.entity_id, ("filter", c.physical_name))
            fc = self.from_clause(g.entity_id, needed, owner_of)
            if fc is None:
                continue
            from_sql, aliases = fc

            where: list[str] = []
            for f in g.filters:
                c = cols.get(f.column_id)
                if c is None:
                    self.err("metric", g.measures[0].name, "a filter of this metric uses a column that no longer exists")
                    continue
                where.append(self.filter_sql(f, c, "t0"))
            if spec.include_default_filters and g.use_defaults:
                for f in table.profile.default_filters:
                    c = cols.get(f.column_id)
                    if c is not None:
                        where.append(self.filter_sql(f, c, "t0"))
                if table.profile.default_filters:
                    self.assumptions.append(f"{table.physical_name}: only rows where " + " and ".join(
                        _describe(f, cols) for f in table.profile.default_filters))
            for f, c in filters:
                where.append(self.filter_sql(f, c, aliases[c.entity_id]))
            for sf, c in set_filters:
                where.append(self.set_filter_sql(sf, c, aliases[c.entity_id]))
            applied = [("metric", f) for f in g.filters]
            if spec.include_default_filters and g.use_defaults:
                applied += [("table default", f) for f in table.profile.default_filters]
            applied += [("question", f) for f, c in filters if c.entity_id == g.entity_id]
            if self.conflict_error(applied, "filter", g.measures[0].name):
                continue

            # periods
            time_col = cols.get(g.time_column_id or "")
            snapshot = table.profile.table_kind == TableKind.SNAPSHOT and table.profile.snapshot_column_id
            period_conds: dict[str, str] = {}
            for ms in g.measures:
                if ms.period and time_col is not None and ms.period not in period_conds:
                    p = spec.periods[ms.period]
                    if snapshot:
                        inner = self.period_sql(time_col, "s", p, table)
                        cond = (f"{self.col_expr(time_col, 't0')} = (SELECT MAX({self.col_expr(time_col, 's')}) "
                                f"FROM {_path(table.physical_path)} AS {_q('s')} WHERE {inner})")
                    else:
                        cond = self.period_sql(time_col, "t0", p, table)
                    if cond:
                        period_conds[ms.period] = cond
            if snapshot and time_col is not None and any(ms.period is None for ms in g.measures):
                where.append(f"{self.col_expr(time_col, 't0')} = (SELECT MAX({self.col_expr(time_col, 's')}) "
                             f"FROM {_path(table.physical_path)} AS {_q('s')})")
                self.assumptions.append(f"{table.physical_name} is a snapshot: the latest snapshot date is used")
            if period_conds and all(ms.period for ms in g.measures):
                where.append(" OR ".join(f"({c})" for c in period_conds.values()) if len(period_conds) > 1
                             else next(iter(period_conds.values())))

            selects, groups_by = [], []
            for c, grain, n in dims:
                a = aliases.get(c.entity_id)
                if a is None:
                    continue
                expr = self.grain_expr(c, a, grain, self.cat.tables[c.entity_id]) if grain else self.col_expr(c, a)
                if expr is None:
                    continue
                selects.append(f"{expr} AS {_q(n)}")
                groups_by.append(expr)
                # a dimension that identifies its table also shows the table's label column
                dt = self.cat.tables[c.entity_id]
                lab = cols.get(dt.profile.label_column_id or "")
                if (not grain and lab is not None and lab.id != c.id
                        and c.id in dt.profile.grain_key_column_ids):
                    ln = f"{n}_label"
                    lexpr = self.col_expr(lab, a)
                    selects.append(f"MAX({lexpr}) AS {_q(ln)}")
                    if (ln, str(gi)) not in label_cols:
                        label_cols.append((ln, str(gi)))
            for ms in g.measures:
                s = self.measure_sql(ms, "t0", period_conds.get(ms.period or ""), cols)
                if s:
                    selects.append(f"{s} AS {_q(ms.name)}")
            sql = f"SELECT {', '.join(selects)} FROM {from_sql}"
            if where:
                sql += " WHERE " + " AND ".join(f"({w})" for w in where)
            if groups_by:
                sql += " GROUP BY " + ", ".join(groups_by)
            ctes.append((f"g{gi}", sql))
        if self.errors:
            return None

        # final layer
        group_names = [n for n, _ in ctes]
        group_of: dict[str, str] = {}
        for (gname, _), g in zip(ctes, groups.values(), strict=True):
            for ms in g.measures:
                group_of[ms.name] = gname
        label_names = list(dict.fromkeys(n for n, _ in label_cols))

        def ref(name: str) -> str:
            if name in group_of:
                return f"{_q(group_of[name])}.{_q(name)}"
            d = next(d for d in self.derived if d.name == name)
            return f"({derived_expr(d)})"

        def over(along_time: bool, frame: str = "") -> str:
            """Time ops run along the time dimension within each other dimension; totals and
            averages are taken within each time bucket."""
            if along_time:
                part = [dim_ref[n] for n in dim_names if n != time_dim]
            else:
                part = [dim_ref[time_dim]] if time_dim else []
            clause = f"PARTITION BY {', '.join(part)}" if part else ""
            if along_time:
                clause += f"{' ' if clause else ''}ORDER BY {dim_ref[time_dim]}{frame}"
            return f"OVER ({clause})"

        def derived_expr(d: Derived) -> str:
            a = [ref(x) for x in d.args]
            scale = f" * {d.scale:g}" if d.scale != 1 else ""
            if d.op == "growth":
                return f"({a[0]} - {a[1]}) * 1.0 / NULLIF({a[1]}, 0){scale}"
            if d.op == "ratio":
                return f"{a[0]} * 1.0 / NULLIF({a[1]}, 0){scale}"
            if d.op == "diff":
                return f"{a[0]} - {a[1]}{scale}"
            if d.op == "share_of_total":
                return f"{a[0]} * 1.0 / NULLIF(SUM({a[0]}) {over(False)}, 0){scale}"
            if d.op == "vs_avg":
                return f"({a[0]} - AVG({a[0]}) {over(False)}){scale}"
            if d.op == "running_sum":
                return f"SUM({a[0]}) {over(True, ' ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')}{scale}"
            if d.op == "moving_avg":
                return f"AVG({a[0]}) {over(True, f' ROWS BETWEEN {d.window - 1} PRECEDING AND CURRENT ROW')}{scale}"
            prev = f"LAG({a[0]}) {over(True)}"
            if d.op == "prev":
                return f"{prev}{scale}"
            if d.op == "change":
                return f"({a[0]} - {prev}){scale}"
            return f"({a[0]} - {prev}) * 1.0 / NULLIF({prev}, 0){scale}"  # pct_change

        first = group_names[0]
        if len(group_names) == 1:
            from_final = _q(first)
            dim_ref = {n: f"{_q(first)}.{_q(n)}" for n in dim_names}
            label_ref = {n: f"{_q(first)}.{_q(n)}" for n in label_names}
            ctes_all = ctes
        else:
            if dim_names:
                keys = ", ".join(_q(n) for n in dim_names)
                spine = " UNION ".join(f"SELECT {keys} FROM {_q(g)}" for g in group_names)
                ctes_all = [*ctes, ("spine", spine)]
                from_final = _q("spine")
                for g in group_names:
                    on = " AND ".join(f"{_q(g)}.{_q(n)} IS NOT DISTINCT FROM {_q('spine')}.{_q(n)}" for n in dim_names)
                    from_final += f" LEFT JOIN {_q(g)} ON {on}"
                dim_ref = {n: f"{_q('spine')}.{_q(n)}" for n in dim_names}
            else:
                ctes_all = ctes
                from_final = " CROSS JOIN ".join(_q(g) for g in group_names)
                dim_ref = {}
            # the label can come from any group that has the dimension; take the first non-empty one
            label_ref = {}
            for n in label_names:
                sources = [f"{_q('g' + gi)}.{_q(ln)}" for ln, gi in label_cols if ln == n]
                label_ref[n] = sources[0] if len(sources) == 1 else f"COALESCE({', '.join(sources)})"

        out_cols: list[OutputColumn] = []
        select_final: list[str] = []
        for c, grain, n in dims:
            select_final.append(f"{dim_ref[n]} AS {_q(n)}")
            out_cols.append(OutputColumn(name=n, kind="dimension", column_id=c.id, time_grain=grain))
            ln = f"{n}_label"
            if ln in label_ref:
                select_final.append(f"{label_ref[ln]} AS {_q(ln)}")
                out_cols.append(OutputColumn(name=ln, kind="label"))
        for ms in measures:
            if not ms.hidden:
                select_final.append(f"{ref(ms.name)} AS {_q(ms.name)}")
                out_cols.append(OutputColumn(name=ms.name, kind="metric", metric_id=ms.metric_id, unit=ms.metric.get("unit")))
        ratio_units = getattr(self, "ratio_units", {})
        for d in self.derived:
            select_final.append(f"{derived_expr(d)} AS {_q(d.name)}")
            unit, mid = ratio_units.get(d.name, (("%" if d.scale == 100 else None), None))
            out_cols.append(OutputColumn(name=d.name, kind="derived", metric_id=mid, unit=unit))
        if any(d.op in TIME_OPS for d in self.derived):
            self.assumptions.append(f"“previous” means the previous {time_dim} that has data")

        rank = spec.rank
        fref = ref
        if windowed and (spec.having or rank):
            # window values can't be filtered or ranked in the same SELECT: compute them first
            ctes_all = [*ctes_all, ("calc", f"SELECT {', '.join(select_final)} FROM {from_final}")]
            from_final = _q("calc")
            select_final = [f"{_q('calc')}.{_q(c.name)} AS {_q(c.name)}" for c in out_cols]
            dim_ref = {n: f"{_q('calc')}.{_q(n)}" for n in dim_names}

            def fref(name: str) -> str:
                return f"{_q('calc')}.{_q(name)}"

        where_final = [f"{fref(h.field)} {'<>' if h.op == '!=' else h.op} {h.value:g}" for h in spec.having]
        simple = len(group_names) == 1 and not self.derived and not where_final and not (rank and rank.partition_by)

        if rank and rank.partition_by:
            part = []
            for pid in rank.partition_by:
                n = next((n for c, _, n in dims if c.id == pid), None)
                if n is None:
                    self.err("rank", "rank.partition_by", "partition columns must be dimensions of the question")
                else:
                    part.append(dim_ref[n])
            order = "ASC" if rank.direction == "asc" else "DESC"
            inner_sql = (f"SELECT {', '.join(select_final)}, RANK() OVER (PARTITION BY {', '.join(part)} "
                         f"ORDER BY {fref(rank.by)} {order}) AS {_q('rnk')} FROM {from_final}")
            if where_final:
                inner_sql += " WHERE " + " AND ".join(where_final)
            ctes_all = [*ctes_all, ("ranked", inner_sql)]
            names_out = [c.name for c in out_cols]
            body = (f"SELECT {', '.join(_q(n) for n in names_out)} FROM {_q('ranked')} "
                    f"WHERE {_q('rnk')} <= {rank.top}")
            if dim_names and not nested:
                body += f" ORDER BY {_q(dim_names[0])}, {_q(rank.by)} {order}"
        else:
            if simple:
                # flat query: the one group's SELECT, with order and limit
                body = ctes[0][1]
                ctes_all = []
            else:
                body = f"SELECT {', '.join(select_final)} FROM {from_final}"
                if where_final:
                    body += " WHERE " + " AND ".join(where_final)
            if not nested:
                body += self.order_and_limit(dims, measures, out_cols)
        if self.errors:
            return None
        return [*set_ctes, *ctes_all], body, out_cols

    def order_and_limit(self, dims: list[tuple[Column, str | None, str]], measures: list[_Measure],
                        out_cols: list[OutputColumn]) -> str:
        spec, rank = self.spec, self.spec.rank
        order_parts = []
        if rank:
            order_parts.append(f"{_q(rank.by)} {'ASC' if rank.direction == 'asc' else 'DESC'}")
        for o in spec.order_by:
            if o.field not in {c.name for c in out_cols}:
                self.err("spec", "order_by", f"unknown result column {o.field!r}")
                continue
            order_parts.append(f"{_q(o.field)} {'ASC' if o.direction == 'asc' else 'DESC'}")
        if not order_parts:
            grain_dim = next((n for _, g, n in dims if g), None)
            if grain_dim:
                order_parts.append(f"{_q(grain_dim)} ASC")
            elif dims and measures and not measures[0].hidden:
                order_parts.append(f"{_q(measures[0].name)} DESC")
            elif dims and self.derived:
                order_parts.append(f"{_q(self.derived[0].name)} DESC")
        sql = " ORDER BY " + ", ".join(order_parts) if order_parts else ""
        limit = rank.top if rank else spec.limit
        if limit is None and dims:
            limit = MAX_ROWS
        if limit is not None:
            sql += f" LIMIT {min(limit, MAX_ROWS)}"
        return sql

    # ── two-level aggregation ──

    def compile_per(self) -> tuple[list[tuple[str, str]], str, list[OutputColumn]] | None:
        """Metrics per key (the normal layers, grouped by the key too) into CTE "per", then
        summaries and buckets over it."""
        spec, per = self.spec, self.spec.per
        assert per is not None
        if spec.metrics:
            self.err("metric", "metrics", "with `per`, put the metrics in per.metrics and summarize them with `summaries`")
        if spec.derived:
            self.err("metric", "derived", "derived values can't be combined with `per`")
        if not spec.summaries:
            self.err("metric", "summaries", "add at least one summary (avg, median, min, max, sum, count)")
        if spec.rank and spec.rank.partition_by:
            self.err("rank", "rank.partition_by", "top N per group can't be combined with `per`")
        key = self.column(per.column_id, "dimension", "per.column_id")
        if key is None:
            return None
        key_table = self.cat.tables[key.entity_id]
        if any(d.column_id == per.column_id for d in spec.dimensions):
            self.err("dimension", "per.column_id", "the per column can't also be a dimension")
        if per.include_zero:
            if key.id not in key_table.profile.grain_key_column_ids:
                self.err("dimension", "per.include_zero", f"{key.physical_name} is not a key of "
                         f"{key_table.physical_name}, so the full list of its values is unknown; use the key "
                         "column of the table that lists them")
            if spec.dimensions:
                self.err("dimension", "per.include_zero", "include_zero (counting things with no rows as 0) works "
                         "only when the result is not split by anything else; set_per again with include_zero=false")
        if self.errors:
            return None

        # rows without a per value belong to no <per> thing: they would make one fake group of their own
        not_null = TypedFilter(column_id=per.column_id, op=FilterOp.IS_NOT_NULL,
                               reason=f"rows without {key.physical_name} are left out")
        inner_spec = spec.model_copy(update={
            "dimensions": [*spec.dimensions, Dimension(column_id=per.column_id)], "metrics": per.metrics,
            "filters": [*spec.filters, not_null],
            "derived": [], "having": [], "rank": None, "order_by": [], "limit": None,
            "per": None, "summaries": [], "buckets": None,
        })
        inner = _Compiler(inner_spec, self.cat)
        inner.ph = self.ph
        parts = inner.aggregate_layers(nested=True)
        for e in inner.errors:
            if e.field.startswith("metrics"):
                e.field = "per." + e.field
        self.errors += inner.errors
        self.assumptions += inner.assumptions
        self.tables_used |= inner.tables_used
        if parts is None or self.errors:
            return None
        ctes, body, inner_cols = parts
        inner_dims = [c for c in inner_cols if c.kind == "dimension"]
        # the inner layers may order dimensions their own way: find the per key by its column, not its place
        key_col = next((c for c in inner_dims if c.column_id == per.column_id and not c.time_grain), inner_dims[-1])
        kname = key_col.name
        group_dims = [c for c in inner_dims if c is not key_col]
        values = {c.name: c for c in inner_cols if c.kind in ("metric", "derived")}

        if per.include_zero:
            where = [f"{self.col_expr(key, 'k')} IS NOT NULL"]
            if spec.include_default_filters:
                where += [self.filter_sql(f, self.cat.columns[f.column_id], "k")
                          for f in key_table.profile.default_filters if f.column_id in self.cat.columns]
            keys_sql = (f"SELECT DISTINCT {self.col_expr(key, 'k')} AS {_q(kname)} "
                        f"FROM {_path(key_table.physical_path)} AS {_q('k')}")
            if where:
                keys_sql += " WHERE " + " AND ".join(f"({w})" for w in where)
            self.tables_used.add(key_table.id)
            sel = [f"{_q('per_keys')}.{_q(kname)} AS {_q(kname)}"]
            for n, c in values.items():
                m = self.cat.metrics.get(c.metric_id or "") or {}
                e = f"{_q('per_rows')}.{_q(n)}"
                zero = m.get("kind") != "ratio" and m.get("aggregation") in ("count", "count_distinct", "sum")
                sel.append(f"COALESCE({e}, 0) AS {_q(n)}" if zero else f"{e} AS {_q(n)}")
            ctes = [*ctes, ("per_rows", body), ("per_keys", keys_sql), ("per", (
                f"SELECT {', '.join(sel)} FROM {_q('per_keys')} LEFT JOIN {_q('per_rows')} "
                f"ON {_q('per_rows')}.{_q(kname)} IS NOT DISTINCT FROM {_q('per_keys')}.{_q(kname)}"))]
            self.assumptions.append(f"every {key.physical_name} of {key_table.physical_name} is included, "
                                    "with 0 when it has no rows")
        else:
            ctes = [*ctes, ("per", body)]
            self.assumptions.append(f"only {key.physical_name} values that have rows are included")
        self.assumptions.append(f"computed per {key.physical_name} first ({', '.join(values)}), then summarized; "
                                f"rows with no {key.physical_name} are left out")

        P = _q("per")
        group_cols: list[tuple[str, str]] = []       # (output name, expression over "per")
        label_cols: list[tuple[str, str]] = []
        out_cols: list[OutputColumn] = []
        for c in group_dims:
            group_cols.append((c.name, f"{P}.{_q(c.name)}"))
            out_cols.append(c)
            label = next((x for x in inner_cols if x.kind == "label" and x.name == f"{c.name}_label"), None)
            if label:
                label_cols.append((label.name, f"MAX({P}.{_q(label.name)})"))
                out_cols.append(label)
        bucket_min = None
        if spec.buckets:
            b = spec.buckets
            if b.of not in values:
                self.err("metric", "buckets.of", f"unknown per metric {b.of!r}", sorted(values))
            else:
                e = f"{P}.{_q(b.of)}"
                m = self.cat.metrics.get(values[b.of].metric_id or "") or {}
                labels = _bucket_labels(b.edges, m.get("aggregation") in ("count", "count_distinct")
                                        and m.get("kind") != "ratio")
                whens = [f"WHEN {e} < {b.edges[0]:g} THEN {_string(labels[0])}"]
                for hi, lab in zip(b.edges[1:], labels[1:-1], strict=True):
                    whens.append(f"WHEN {e} < {hi:g} THEN {_string(lab)}")
                whens.append(f"WHEN {e} >= {b.edges[-1]:g} THEN {_string(labels[-1])}")
                group_cols.append((f"{b.of}_range", f"CASE {' '.join(whens)} END"))
                out_cols.append(OutputColumn(name=f"{b.of}_range", kind="dimension"))
                bucket_min = f"MIN({e})"
        summaries: list[tuple[str, str]] = []
        for i, sm in enumerate(spec.summaries):
            if sm.of is not None and sm.of not in values:
                self.err("metric", f"summaries[{i}].of", f"unknown per metric {sm.of!r}", sorted(values))
                continue
            if sm.name in {c.name for c in out_cols}:
                self.err("metric", f"summaries[{i}].name", f"{sm.name!r} is used twice")
                continue
            summaries.append((sm.name, "COUNT(*)" if sm.agg == "count" else f"{sm.agg.upper()}({P}.{_q(sm.of or '')})"))
            unit = None if sm.agg == "count" else values[sm.of or ""].unit
            out_cols.append(OutputColumn(name=sm.name, kind="metric", unit=unit))
        summary_names = [n for n, _ in summaries]
        for i, h in enumerate(spec.having):
            if h.field not in summary_names:
                self.err("rank", f"having[{i}]", f"unknown summary {h.field!r}", summary_names)
        if spec.rank and spec.rank.by not in summary_names:
            self.err("rank", "rank.by", f"unknown summary {spec.rank.by!r}", summary_names)
        if self.errors:
            return None

        def select(cols_: list[tuple[str, str]]) -> str:
            sql = f"SELECT {', '.join(f'{e} AS {_q(n)}' for n, e in cols_)} FROM {P}"
            return sql + (" GROUP BY " + ", ".join(e for _, e in group_cols) if group_cols else "")

        # Dremio can't plan MEDIAN next to MIN/MAX/SUM in one SELECT: medians get their own CTE
        medians = [(n, e) for n, e in summaries if e.startswith("MEDIAN(")]
        others = [(n, e) for n, e in summaries if not e.startswith("MEDIAN(")]
        split = bool(medians) and any(e.split("(")[0] in ("MIN", "MAX", "SUM") for _, e in others)
        if split:
            A, B = _q("summary"), _q("medians")
            hidden = [("__order", bucket_min)] if bucket_min else []
            ctes = [*ctes, ("summary", select([*group_cols, *label_cols, *others, *hidden])),
                    ("medians", select([*group_cols, *medians]))]
            on = " AND ".join(f"{A}.{_q(n)} IS NOT DISTINCT FROM {B}.{_q(n)}" for n, _ in group_cols)
            refs = {n: f"{A}.{_q(n)}" for n, _ in [*group_cols, *label_cols, *others]}
            refs |= {n: f"{B}.{_q(n)}" for n, _ in medians}
            body = (f"SELECT {', '.join(f'{refs[c.name]} AS {_q(c.name)}' for c in out_cols)} FROM {A} "
                    + (f"JOIN {B} ON {on}" if on else f"CROSS JOIN {B}"))
            cond = [f"{refs[h.field]} {'<>' if h.op == '!=' else h.op} {h.value:g}" for h in spec.having]
            if cond:
                body += " WHERE " + " AND ".join(cond)
            bucket_order = f"{A}.{_q('__order')} ASC" if bucket_min else None
        else:
            exprs = dict(summaries)
            body = select([*group_cols, *label_cols, *summaries])
            cond = [f"{exprs[h.field]} {'<>' if h.op == '!=' else h.op} {h.value:g}" for h in spec.having]
            if cond:
                body += " HAVING " + " AND ".join(cond)
            bucket_order = f"{bucket_min} ASC" if bucket_min else None

        order_parts = []
        if spec.rank:
            order_parts.append(f"{_q(spec.rank.by)} {'ASC' if spec.rank.direction == 'asc' else 'DESC'}")
        for o in spec.order_by:
            if o.field not in {c.name for c in out_cols}:
                self.err("spec", "order_by", f"unknown result column {o.field!r}")
                continue
            order_parts.append(f"{_q(o.field)} {'ASC' if o.direction == 'asc' else 'DESC'}")
        if not order_parts:
            grain = next((c.name for c in group_dims if c.time_grain), None)
            if grain:
                order_parts.append(f"{_q(grain)} ASC")
            if bucket_order:
                order_parts.append(bucket_order)
            elif group_cols and not grain:
                order_parts.append(f"{_q(summary_names[0])} DESC")
        if order_parts:
            body += " ORDER BY " + ", ".join(order_parts)
        limit = spec.rank.top if spec.rank else spec.limit
        if limit is None and group_cols:
            limit = MAX_ROWS
        if limit is not None:
            body += f" LIMIT {min(limit, MAX_ROWS)}"
        return ctes, body, out_cols

    # ── detail ──

    def compile_detail(self) -> Compiled | None:
        spec = self.spec
        table = self.cat.tables.get(spec.entity_id or "")
        if table is None:
            self.err("detail", "entity_id", "pick the table to list rows from")
            return None
        if not spec.columns:
            self.err("detail", "columns", "pick the columns to show")
        cols_out: list[Column] = []
        for i, cid in enumerate(spec.columns):
            c = self.column(cid, "detail", f"columns[{i}]")
            if c is None:
                continue
            if c.entity_id != table.id:
                self.err("detail", f"columns[{i}]", f"{c.physical_name} is not a column of {table.physical_name}")
                continue
            cols_out.append(c)
        if spec.per or spec.summaries or spec.buckets:
            self.err("spec", "per", "`per`, `summaries` and `buckets` belong to the aggregate shape")
        filters = self.checked_filters()
        set_filters = self.checked_set_filters()
        set_ctes = self.build_sets()
        if self.errors:
            return None
        fc = self.from_clause(table.id, {c.entity_id for _, c in [*filters, *set_filters]},
                              {c.entity_id: ("filter", c.physical_name) for _, c in [*filters, *set_filters]})
        if fc is None:
            return None
        from_sql, aliases = fc
        allc = {c.id: c for c in self.cat.columns.values()}
        where = []
        if spec.include_default_filters:
            # row lists use their own filters; a table without them falls back to the default filters
            row_filters = table.profile.list_filters or table.profile.default_filters
            for f in row_filters:
                c = allc.get(f.column_id)
                if c is not None:
                    where.append(self.filter_sql(f, c, "t0"))
            if row_filters:
                self.assumptions.append(f"{table.physical_name}: only rows where " + " and ".join(
                    _describe(f, allc) for f in row_filters))
        for f, c in filters:
            where.append(self.filter_sql(f, c, aliases[c.entity_id]))
        for sf, c in set_filters:
            where.append(self.set_filter_sql(sf, c, aliases[c.entity_id]))
        time_col = allc.get(spec.time_column_id or table.profile.time_column_id or "")
        if spec.detail_period:
            p = spec.periods.get(spec.detail_period)
            if p is None:
                self.err("period", "detail_period", f"no period named {spec.detail_period!r}")
            elif time_col is None:
                self.err("period", "detail_period", f"{table.physical_name} has no time column")
            else:
                cond = self.period_sql(time_col, "t0", p, table)
                if cond:
                    where.append(cond)
        names: list[str] = []
        selects = []
        out_cols = []
        for c in cols_out:
            n = c.physical_name.replace(".", "_")
            names.append(n)
            selects.append(f"{self.col_expr(c, 't0')} AS {_q(n)}")
            out_cols.append(OutputColumn(name=n, kind="column", column_id=c.id))
        sql = f"SELECT {', '.join(selects)} FROM {from_sql}"
        if where:
            sql += " WHERE " + " AND ".join(f"({w})" for w in where)
        order_parts = []
        for o in spec.order_by:
            if o.field not in names:
                self.err("spec", "order_by", f"unknown result column {o.field!r}")
                continue
            order_parts.append(f"{_q(o.field)} {'ASC' if o.direction == 'asc' else 'DESC'}")
        if not order_parts and time_col is not None:
            order_parts.append(f"{self.col_expr(time_col, 't0')} DESC")
        if order_parts:
            sql += " ORDER BY " + ", ".join(order_parts)
        sql += f" LIMIT {min(spec.limit or DETAIL_DEFAULT_LIMIT, MAX_ROWS)}"
        if self.errors:
            return None
        return self.finish(_with(set_ctes, sql), "detail", out_cols)

    def finish(self, sql: str, shape: str, out_cols: list[OutputColumn]) -> Compiled | None:
        reason = check_read_only_sql(sql, dialect="dremio")
        if reason:
            self.err("spec", "sql", f"the generated SQL was rejected: {reason}")
            return None
        return Compiled(
            sql=self.ph.finish(sql), shape=shape, columns=out_cols,
            tables=sorted(self.tables_used), assumptions=list(dict.fromkeys(a for a in self.assumptions if a)),
        )


def _with(ctes: list[tuple[str, str]], body: str) -> str:
    return body if not ctes else "WITH " + ", ".join(f"{_q(n)} AS ({s})" for n, s in ctes) + " " + body


def _bucket_labels(edges: list[float], whole: bool) -> list[str]:
    """Range names for bucket edges, ASCII only (Dremio can't plan a selected non-ASCII literal).
    Counts read naturally: [2, 5] → "0-1", "2-4", "5+"; other values: "< 2", "2 to < 5", ">= 5"."""
    if whole and all(e == int(e) and e >= 1 for e in edges):
        ints = [int(e) for e in edges]

        def span(lo: int, hi: int) -> str:
            return str(lo) if lo == hi else f"{lo}-{hi}"

        return [span(0, ints[0] - 1), *(span(lo, hi - 1) for lo, hi in zip(ints, ints[1:], strict=False)),
                f"{ints[-1]}+"]
    return [f"< {edges[0]:g}", *(f"{lo:g} to < {hi:g}" for lo, hi in zip(edges, edges[1:], strict=False)),
            f">= {edges[-1]:g}"]


def _describe(f: TypedFilter, cols: dict[str, Column]) -> str:
    name = cols[f.column_id].physical_name if f.column_id in cols else "?"
    if f.op == FilterOp.IS_NULL:
        return f"{name} is empty"
    if f.op == FilterOp.IS_NOT_NULL:
        return f"{name} is not empty"
    return f"{name} {f.op.value} {', '.join(map(str, f.values))}"


_VALUE_OPS = {FilterOp.EQ, FilterOp.IN}
_EXCLUDE_OPS = {FilterOp.NEQ, FilterOp.NOT_IN}


def _conflict(applied: list[tuple[str, TypedFilter]]) -> tuple[tuple[str, TypedFilter], tuple[str, TypedFilter]] | None:
    """Two filters on the same column that no row can satisfy together (e.g. deleted_at is empty
    and deleted_at is not empty, or status = DONE and status = CANCELLED)."""
    for i, (sa, a) in enumerate(applied):
        for sb, b in applied[i + 1:]:
            if a.column_id != b.column_id:
                continue
            ops = {a.op, b.op}
            va = {str(v).strip().lower() for v in a.values}
            vb = {str(v).strip().lower() for v in b.values}
            if FilterOp.IS_NULL in ops and ops != {FilterOp.IS_NULL}:
                return (sa, a), (sb, b)  # empty never equals, compares or "is not empty"
            if a.op in _VALUE_OPS and b.op in _VALUE_OPS and not va & vb:
                return (sa, a), (sb, b)
            if a.op in _VALUE_OPS and b.op in _EXCLUDE_OPS and va <= vb:
                return (sa, a), (sb, b)
            if b.op in _VALUE_OPS and a.op in _EXCLUDE_OPS and vb <= va:
                return (sa, a), (sb, b)
    return None


@timed("compile")
async def compile_spec(spec: QuerySpec, catalog: Catalog) -> Compiled:
    """Raises CompileError with every problem found (each tagged with the agent that owns it)."""
    c = _Compiler(spec, catalog)
    result = c.compile_detail() if spec.shape == "detail" else c.compile_aggregate()
    if result is None or c.errors:
        raise CompileError(c.errors or [SpecError(owner="spec", field="spec", message="could not compile")])
    return result
