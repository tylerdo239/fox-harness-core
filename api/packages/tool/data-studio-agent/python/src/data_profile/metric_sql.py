"""Build and run a metric's SQL on demand, so the person defining it can check the number.

Runs only when someone presses Run in the metric form (never automatically), as one read-only
aggregate query per metric. A ratio runs its numerator and denominator metrics.
"""

import time
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, ValidationError

from src.crud_mongo import entity as entity_crud
from src.data_profile import service
from src.data_profile.metrics import MetricInput, MetricKind, get_doc
from src.data_profile.models import FilterOp, TableKind, TypedFilter
from src.database.mongodb import AttrDatabase
from src.services.dremio_client import DremioClient, DremioQueryError
from src.services.sql_safety import check_read_only_sql
from src.settings import Settings

_NUMERIC = {"INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT", "DECIMAL", "DOUBLE", "FLOAT", "NUMERIC"}
_TIMESTAMP = {"TIMESTAMP", "TIMESTAMPTZ", "DATETIME"}
_TEXT_DATE_FORMATS = {"YYYYMMDD": "%Y%m%d", "YYYY-MM-DD": "%Y-%m-%d", "YYYYMM": "%Y%m", "YYYY-MM": "%Y-%m", "YYYY": "%Y"}


class MetricRunError(ValueError):
    pass


class SqlPart(BaseModel):
    label: str
    sql: str
    value: float | None = None


class MetricRunResult(BaseModel):
    value: float | None
    parts: list[SqlPart]
    elapsed_ms: int
    period: str | None
    reference: dict[str, Any] | None = None  # {value, source, diff_pct}
    notes: list[str] = Field(default_factory=list)


# ── SQL text helpers (identifiers and literals are always escaped) ──

def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _path(physical_path: str) -> str:
    return ".".join(_ident(p) for p in physical_path.split("."))


def _string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _literal(value: Any, data_type: str) -> str:
    t = data_type.upper()
    if t in _NUMERIC:
        try:
            number = float(str(value).replace(",", "."))
        except ValueError as err:
            raise MetricRunError(f"{value!r} is not a number") from err
        return str(int(number)) if number.is_integer() else repr(number)
    if t == "BOOLEAN":
        text = str(value).strip().lower()
        if text in ("1", "true", "yes", "có"):
            return "TRUE"
        if text in ("0", "false", "no", "không"):
            return "FALSE"
        raise MetricRunError(f"{value!r} is not true/false")
    return _string(str(value))


def _json_expr(col: dict[str, Any]) -> str:
    """TRY_CONVERT_FROM("config" AS ROW("a" ROW("b" BOOLEAN)))."a"."b" for the JSON field config → a.b.
    Built only from validated names and the fixed list of JSON field types."""
    parts = col["json_path"].split(".")
    row_type = col["data_type"]
    for part in reversed(parts):
        row_type = f"ROW({_ident(part)} {row_type})"
    access = "".join(f".{_ident(p)}" for p in parts)
    return f"(TRY_CONVERT_FROM({_ident(col['json_source'])} AS {row_type})){access}"


class _Expressions:
    """Column expressions for one query. JSON fields get a placeholder identifier, so the read-only
    check (whose parser doesn't know TRY_CONVERT_FROM … AS ROW) can verify the rest of the query;
    the real expressions are put back afterwards."""

    def __init__(self) -> None:
        self.placeholders: dict[str, str] = {}

    def of(self, col: dict[str, Any]) -> str:
        if not col.get("json_source"):
            return _ident(col["physical_name"])
        real = _json_expr(col)
        for name, expr in self.placeholders.items():
            if expr == real:
                return name
        name = f'"__json_field_{len(self.placeholders)}__"'
        self.placeholders[name] = real
        return name

    def finish(self, checked_sql: str) -> str:
        for name, expr in self.placeholders.items():
            checked_sql = checked_sql.replace(name, expr)
        return checked_sql


def _filter_sql(f: TypedFilter, columns: dict[str, dict[str, Any]], ex: _Expressions) -> str:
    col = columns.get(f.column_id)
    if col is None:
        raise MetricRunError("A filter uses a column that is not in the table")
    name, t = ex.of(col), str(col.get("data_type") or "")
    if f.op == FilterOp.IS_NULL:
        return f"{name} IS NULL"
    if f.op == FilterOp.IS_NOT_NULL:
        return f"{name} IS NOT NULL"
    values = [_literal(v, t) for v in f.values]
    if f.op in (FilterOp.IN, FilterOp.NOT_IN):
        return f"{name} {'NOT IN' if f.op == FilterOp.NOT_IN else 'IN'} ({', '.join(values)})"
    op = "<>" if f.op == FilterOp.NEQ else f.op.value
    return f"{name} {op} {values[0]}"


# ── periods ──

def _period_range(period: str) -> tuple[date, date]:
    parts = [int(p) for p in period.split("-")]
    if len(parts) == 1:
        return date(parts[0], 1, 1), date(parts[0] + 1, 1, 1)
    if len(parts) == 2:
        y, m = parts
        return date(y, m, 1), date(y + (m == 12), m % 12 + 1, 1)
    start = date(*parts)
    return start, date.fromordinal(start.toordinal() + 1)


def _zone(name: str | None) -> ZoneInfo | None:
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as err:
        raise MetricRunError(f"Unknown time zone {name!r} in the table profile") from err


def _time_condition(
    col: dict[str, Any], start: date, end: date, business_tz: str | None, storage_tz: str | None, ex: _Expressions
) -> str:
    name, t = ex.of(col), str(col.get("data_type") or "").upper()
    if t == "DATE":
        return f"{name} >= DATE '{start.isoformat()}' AND {name} < DATE '{end.isoformat()}'"
    if t in _TIMESTAMP:
        bz, sz = _zone(business_tz), _zone(storage_tz)

        def stamp(d: date) -> str:
            moment = datetime(d.year, d.month, d.day, tzinfo=bz) if bz else datetime(d.year, d.month, d.day)
            if bz and sz:
                moment = moment.astimezone(sz)
            return moment.strftime("%Y-%m-%d %H:%M:%S")

        return f"{name} >= TIMESTAMP '{stamp(start)}' AND {name} < TIMESTAMP '{stamp(end)}'"
    fmt = service.column_profile(col).date_format
    py = _TEXT_DATE_FORMATS.get(fmt or "")
    if py is None:
        raise MetricRunError(
            f"{col['physical_name']} is stored as {t or 'text'}: set its date format (e.g. YYYYMMDD) to filter by period"
        )
    lo, hi = start.strftime(py), end.strftime(py)
    if t in _NUMERIC:
        return f"{name} >= {lo} AND {name} < {hi}"
    return f"{name} >= {_string(lo)} AND {name} < {_string(hi)}"


# ── building ──

def _aggregate_sql(db: AttrDatabase, m: MetricInput, period: str | None, notes: list[str]) -> str:
    entity = entity_crud.get_by_id(db, m.entity_id) if m.entity_id else None
    if entity is None:
        raise MetricRunError("Pick the table first")
    if m.aggregation is None:
        raise MetricRunError("Pick the aggregation first")
    profile = service.entity_profile(entity)
    columns = {c["_id"]: c for c in service.columns_with_json(service.entity_columns(db, entity["_id"]))}
    ex = _Expressions()
    if m.aggregation != "count" and m.column_id not in columns:
        raise MetricRunError("Pick the column first")

    target = ex.of(columns[m.column_id]) if m.column_id in columns else "*"
    agg = {"count_distinct": f"COUNT(DISTINCT {target})"}.get(m.aggregation, f"{m.aggregation.upper()}({target})")
    table = _path(entity["physical_path"])

    conds = [_filter_sql(f, columns, ex) for f in m.filters]
    if m.use_table_default_filters:
        conds += [_filter_sql(f, columns, ex) for f in profile.default_filters]

    period_cond = None
    if period:
        start, end = _period_range(period)
        time_id = m.time_column_id or profile.time_column_id
        if profile.table_kind == TableKind.SNAPSHOT and profile.snapshot_column_id in columns:
            time_id = profile.snapshot_column_id
        if time_id not in columns:
            raise MetricRunError("This table has no time column; clear the period or set the table's main time column")
        period_cond = _time_condition(columns[time_id], start, end, profile.business_tz, profile.storage_tz, ex)

    if profile.table_kind == TableKind.SNAPSHOT and profile.snapshot_column_id in columns:
        snap = ex.of(columns[profile.snapshot_column_id])
        inner = f"SELECT MAX({snap}) FROM {table}" + (f" WHERE {period_cond}" if period_cond else "")
        conds.append(f"{snap} = ({inner})")
        notes.append("Snapshot table: counted on the last snapshot date" + (" of the period." if period else "."))
    elif period_cond:
        conds.append(period_cond)
    elif not period:
        notes.append("No period: the whole table is counted.")

    sql = f'SELECT {agg} AS "metric_value" FROM {table}'
    if conds:
        sql += " WHERE " + " AND ".join(f"({c})" for c in conds)
    reason = check_read_only_sql(sql, dialect="dremio")
    if reason:
        raise MetricRunError(f"The generated SQL was rejected: {reason}")
    return ex.finish(sql)


def _to_number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _run(client: DremioClient, sql: str) -> float | None:
    try:
        rows = client.run_sql(sql, timeout_sec=60)
    except DremioQueryError as err:
        first_line = str(err).strip().splitlines()[0] if str(err).strip() else "query failed"
        raise MetricRunError(f"Dremio: {first_line}") from err
    return _to_number(rows[0].get("metric_value")) if rows else None


def run_metric(
    db: AttrDatabase, settings: Settings, draft: dict[str, Any], period: str | None
) -> MetricRunResult:
    try:
        metric = MetricInput.model_validate({**draft, "name": draft.get("name") or "draft_metric"})
    except ValidationError as err:
        first = err.errors()[0]
        raise MetricRunError(f"{'.'.join(map(str, first.get('loc', ())))}: {first.get('msg')}") from err
    period = (period or "").strip() or None
    if period:
        try:
            _period_range(period)
        except (ValueError, TypeError) as err:
            raise MetricRunError("Period must be YYYY, YYYY-MM or YYYY-MM-DD") from err

    notes: list[str] = []
    client = DremioClient(settings)
    started = time.monotonic()
    if metric.kind == MetricKind.RATIO:
        parts = []
        for label, mid in (("Numerator", metric.numerator_metric_id), ("Denominator", metric.denominator_metric_id)):
            doc = get_doc(db, mid) if mid else None
            if doc is None:
                raise MetricRunError(f"Pick the {label.lower()} metric first")
            sub = MetricInput.model_validate(doc)
            if sub.kind == MetricKind.RATIO:
                raise MetricRunError(f"{label} {sub.name} is itself a ratio; run it on its own first")
            sql = _aggregate_sql(db, sub, period, notes)
            parts.append(SqlPart(label=f"{label}: {sub.name}", sql=sql, value=_run(client, sql)))
        num, den = parts[0].value, parts[1].value
        value = None if num is None or not den else num / den * metric.ratio_scale
        if den == 0:
            notes.append("The denominator is 0, so the ratio is empty.")
    else:
        sql = _aggregate_sql(db, metric, period, notes)
        value = _run(client, sql)
        parts = [SqlPart(label="Metric", sql=sql, value=value)]

    reference = None
    if period:
        ref = next((r for r in metric.reference_values if r.period == period), None)
        if ref is not None:
            diff = None if value is None or ref.value == 0 else (value - ref.value) / abs(ref.value) * 100
            reference = {"value": ref.value, "source": ref.source, "diff_pct": diff}
    return MetricRunResult(
        value=value, parts=parts, elapsed_ms=int((time.monotonic() - started) * 1000),
        period=period, reference=reference, notes=list(dict.fromkeys(notes)),
    )


class JsonFieldCheck(BaseModel):
    total_rows: int
    rows_with_value: int
    sql: str


def check_json_field(
    settings: Settings, entity: dict[str, Any], column: dict[str, Any], path: str, data_type: str
) -> JsonFieldCheck:
    """Count how many rows have the JSON field (as the given type). Runs once, when a person clicks
    Check; returns counts only, never values."""
    from src.data_profile.models import JsonField  # local: keeps the module's import list short

    try:
        field = JsonField(path=path, data_type=data_type)
    except ValidationError as err:
        raise MetricRunError(err.errors()[0].get("msg", "invalid JSON field")) from err
    pseudo = {"json_source": column["physical_name"], "json_path": field.path, "data_type": field.data_type.value}
    ex = _Expressions()
    target = ex.of(pseudo)
    sql = f'SELECT COUNT(*) AS "total_rows", COUNT({target}) AS "rows_with_value" FROM {_path(entity["physical_path"])}'
    reason = check_read_only_sql(sql, dialect="dremio")
    if reason:
        raise MetricRunError(f"The generated SQL was rejected: {reason}")
    sql = ex.finish(sql)
    try:
        rows = DremioClient(settings).run_sql(sql, timeout_sec=60)
    except DremioQueryError as err:
        first_line = str(err).strip().splitlines()[0] if str(err).strip() else "query failed"
        raise MetricRunError(f"Dremio: {first_line}") from err
    row = rows[0] if rows else {}
    return JsonFieldCheck(
        total_rows=int(row.get("total_rows") or 0), rows_with_value=int(row.get("rows_with_value") or 0), sql=sql
    )
