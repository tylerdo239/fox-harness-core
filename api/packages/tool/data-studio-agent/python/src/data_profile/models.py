"""Human-entered data profile (pipeline v4).

Every value here is typed in by a DE/DA — nothing is computed by running SQL. The profile lives in
a `profile` subdocument on the existing `entities`, `entity_columns` and `relationships`
documents, plus a `profile_review` subdocument on entities. Missing documents/fields read as the
defaults below, so no migration is needed.
"""

import re
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field, field_validator


class TableKind(StrEnum):
    FACT = "fact"          # events/transactions: one row per order, per call…
    DIM = "dim"            # lookup/master data: one row per branch, per customer…
    SNAPSHOT = "snapshot"  # state captured per day/month: stock at end of day…
    SCD2 = "scd2"          # dimension with history rows (valid_from / valid_to)


class Trust(StrEnum):
    CERTIFIED = "certified"
    RAW = "raw"


class Additive(StrEnum):
    ALL = "all"            # can be summed across every dimension, including time
    NOT_TIME = "not_time"  # can be summed across branches/products but NOT across days (stock, balance)
    NONE = "none"          # never summed (ratios, prices, distinct counts)


class FilterOp(StrEnum):
    EQ = "="
    NEQ = "!="
    IN = "in"
    NOT_IN = "not_in"
    GT = ">"
    GTE = ">="
    LT = "<"
    LTE = "<="
    IS_NULL = "is_null"
    IS_NOT_NULL = "is_not_null"


NO_VALUE_OPS = {FilterOp.IS_NULL, FilterOp.IS_NOT_NULL}
MULTI_VALUE_OPS = {FilterOp.IN, FilterOp.NOT_IN}

FilterValue = str | int | float | bool


class TypedFilter(BaseModel):
    column_id: str
    op: FilterOp
    values: list[FilterValue] = Field(default_factory=list)
    reason: str | None = None


class ValueCatalogItem(BaseModel):
    value: str                     # the value exactly as stored, e.g. "DONE"
    label: str | None = None       # what people call it, e.g. "Hoàn tất"
    synonyms: list[str] = Field(default_factory=list)
    count: int | None = None       # optional, rough number of rows

    @field_validator("value")
    @classmethod
    def _value_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("value must not be empty")
        return v


class JsonFieldType(StrEnum):
    BOOLEAN = "BOOLEAN"
    VARCHAR = "VARCHAR"
    INTEGER = "INTEGER"
    BIGINT = "BIGINT"
    DOUBLE = "DOUBLE"
    DATE = "DATE"
    TIMESTAMP = "TIMESTAMP"


_JSON_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


class JsonField(BaseModel):
    """A field inside a text column that holds JSON, e.g. config → is_intent_node.

    Code reads it with TRY_CONVERT_FROM; people only declare the path and type."""

    path: str                          # "is_intent_node" or nested "limits.max_tokens"
    data_type: JsonFieldType
    display_name: str | None = None
    description: str | None = None
    value_catalog: list[ValueCatalogItem] = Field(default_factory=list)
    value_catalog_complete: bool = False

    @field_validator("path")
    @classmethod
    def _path_format(cls, v: str) -> str:
        v = v.strip()
        parts = v.split(".")
        if not v or any(not _JSON_KEY.match(p) for p in parts) or len(parts) > 5:
            raise ValueError("JSON path must be field names separated by dots, e.g. is_intent_node or limits.max_tokens")
        return v


class EntityProfile(BaseModel):
    table_kind: TableKind | None = None
    trust: Trust | None = None
    grain_key_column_ids: list[str] = Field(default_factory=list)
    label_column_id: str | None = None  # the column that names a row, e.g. agent_name for agent_id

    time_column_id: str | None = None
    storage_tz: str | None = None      # how timestamps are stored, e.g. "UTC"
    business_tz: str | None = None     # how people count days/months, e.g. "Asia/Ho_Chi_Minh"
    snapshot_column_id: str | None = None

    coverage_start: str | None = None  # "YYYY-MM-DD"
    coverage_end: str | None = None    # "YYYY-MM-DD" or empty = ongoing (data is always treated as current)
    coverage_gaps: str | None = None   # free text: "no data 10/02–14/02/2024 (Tết)"

    default_filters: list[TypedFilter] = Field(default_factory=list)
    default_filters_confirmed: bool = False  # true = someone checked; empty list means "none needed"
    list_filters: list[TypedFilter] = Field(default_factory=list)

    caveats: list[str] = Field(default_factory=list)
    notes: str | None = None


class ColumnProfile(BaseModel):
    value_catalog: list[ValueCatalogItem] = Field(default_factory=list)
    value_catalog_complete: bool = False  # true = the list holds EVERY value the column can take
    values_ordered: bool = False          # true = value_catalog order is the natural order (Bronze < Silver < Gold)
    pattern: str | None = None            # format of ids/codes, e.g. "BR-0001"
    date_format: str | None = None        # for dates stored as text/number, e.g. "YYYYMMDD", "YYYY-MM"
    parent_column_id: str | None = None   # next level up in the same table, e.g. province → region

    unit: str | None = None               # "VND", "cái", "%", "phút"
    scale: float | None = None            # 1000 when the column stores thousands of VND
    additive: Additive | None = None
    sign_convention: str | None = None    # "refunds are negative"
    null_meaning: str | None = None       # "cancelled order, no amount"
    normal_min: float | None = None
    normal_max: float | None = None       # values above this are suspicious

    notes: str | None = None
    json_fields: list[JsonField] = Field(default_factory=list)  # fields inside a JSON text column

    @field_validator("json_fields")
    @classmethod
    def _unique_json_paths(cls, items: list["JsonField"]) -> list["JsonField"]:
        seen: set[str] = set()
        for item in items:
            if item.path in seen:
                raise ValueError(f"JSON field {item.path!r} is listed twice")
            seen.add(item.path)
        return items

    @field_validator("scale")
    @classmethod
    def _scale_positive(cls, v: float | None) -> float | None:
        if v is not None and v <= 0:
            raise ValueError("scale must be greater than 0")
        return v

    @field_validator("value_catalog")
    @classmethod
    def _unique_values(cls, items: list[ValueCatalogItem]) -> list[ValueCatalogItem]:
        seen: set[str] = set()
        for item in items:
            if item.value in seen:
                raise ValueError(f"duplicate value in value catalog: {item.value!r}")
            seen.add(item.value)
        return items


class RelationshipProfile(BaseModel):
    match_rate: float | None = None     # share of rows on the "from" side that find a match, 0–1
    fanout_ratio: float | None = None   # rows after join / rows before join
    notes: str | None = None

    @field_validator("match_rate")
    @classmethod
    def _rate_range(cls, v: float | None) -> float | None:
        if v is not None and not 0 <= v <= 1:
            raise ValueError("match_rate must be between 0 and 1")
        return v

    @field_validator("fanout_ratio")
    @classmethod
    def _fanout_positive(cls, v: float | None) -> float | None:
        if v is not None and v <= 0:
            raise ValueError("fanout_ratio must be greater than 0")
        return v


class ProfileReview(BaseModel):
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    needs_review: bool = False
    needs_review_reasons: list[str] = Field(default_factory=list)
