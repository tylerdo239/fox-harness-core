from dataclasses import dataclass, field
from enum import StrEnum

import sqlglot
from sqlglot import exp
from sqlglot.errors import OptimizeError, ParseError
from sqlglot.optimizer.qualify import qualify
from sqlmodel import Session, select

from src.database.models import Entity, EntityColumn

DEFAULT_LIMIT = 1000


class ValidationErrorType(StrEnum):
    PARSE_ERROR = "parse_error"
    NOT_SELECT_ONLY = "not_select_only"
    UNKNOWN_TABLE = "unknown_table"
    UNKNOWN_COLUMN = "unknown_column"
    BLOCKED_COLUMN = "blocked_column"


@dataclass
class ValidationError:
    error_type: ValidationErrorType
    message: str


@dataclass
class ValidationResult:
    is_valid: bool
    sql: str | None = None
    errors: list[ValidationError] = field(default_factory=list)


def build_schema_for_entities(session: Session, entity_ids: list[int]) -> dict:
    """Build a SQLGlot-shaped schema dict {catalog: {db: {table: {col: type}}}}
    scoped to the given entities, using only real physical names from our catalog."""
    schema: dict = {}
    entities = session.exec(select(Entity).where(Entity.id.in_(entity_ids))).all()

    for entity in entities:
        path_parts = entity.physical_path.split(".")
        if len(path_parts) != 3:
            continue
        catalog, db, table = path_parts

        columns = session.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == entity.id,
                EntityColumn.is_deprecated == False,  # noqa: E712
            )
        ).all()

        col_types = {col.physical_name: col.data_type for col in columns}
        schema.setdefault(catalog, {}).setdefault(db, {})[table] = col_types

    return schema


def _blocked_columns_for_entities(session: Session, entity_ids: list[int]) -> set[tuple[str, str]]:
    """Returns {(table_physical_name, column_physical_name)} for columns that must
    never be exposed to the agent (not is_exposed, or is_pii)."""
    columns = session.exec(
        select(EntityColumn, Entity)
        .join(Entity, EntityColumn.entity_id == Entity.id)
        .where(
            Entity.id.in_(entity_ids),
            EntityColumn.is_deprecated == False,  # noqa: E712
        )
    ).all()

    blocked = set()
    for col, entity in columns:
        if not col.is_exposed or col.is_pii:
            blocked.add((entity.physical_name, col.physical_name))
    return blocked


def _allowed_table_paths(session: Session, entity_ids: list[int]) -> set[str]:
    entities = session.exec(select(Entity).where(Entity.id.in_(entity_ids))).all()
    return {e.physical_path for e in entities}


def validate_sql(
    session: Session,
    sql: str | exp.Select,
    entity_ids: list[int],
    limit: int = DEFAULT_LIMIT,
) -> ValidationResult:
    """Accepts either a raw SQL string (re-parsed here) or an already-built exp.Select AST.
    Pass the AST directly when the SQL may contain Dremio-specific syntax that SQLGlot's
    parser can't round-trip (e.g. glossary expressions using TRY_CONVERT_FROM(... AS
    ROW(...))) — those are embedded as opaque exp.Var fragments by the generator and are
    valid, dialect-specific SQL that simply can't be re-parsed from text, even though it
    executes correctly on Dremio. qualify() safely skips over exp.Var nodes since they
    aren't exp.Column, so identifier validation still runs for everything else."""
    errors: list[ValidationError] = []

    if isinstance(sql, exp.Select):
        tree = sql
    else:
        try:
            tree = sqlglot.parse_one(sql)
        except ParseError as e:
            return ValidationResult(
                is_valid=False,
                errors=[ValidationError(ValidationErrorType.PARSE_ERROR, str(e))],
            )

    if not isinstance(tree, exp.Select):
        return ValidationResult(
            is_valid=False,
            errors=[
                ValidationError(
                    ValidationErrorType.NOT_SELECT_ONLY,
                    f"Only SELECT statements are allowed, got {type(tree).__name__}",
                )
            ],
        )

    allowed_paths = _allowed_table_paths(session, entity_ids)
    for table in tree.find_all(exp.Table):
        path_parts = [p for p in (table.catalog, table.db, table.name) if p]
        table_path = ".".join(path_parts)
        if table_path not in allowed_paths:
            errors.append(
                ValidationError(
                    ValidationErrorType.UNKNOWN_TABLE,
                    f"Table '{table_path}' is not in the allowed entity list",
                )
            )

    if errors:
        return ValidationResult(is_valid=False, errors=errors)

    schema = build_schema_for_entities(session, entity_ids)
    # Strict column resolution can't see columns projected by a CTE (a WITH clause), so it
    # wrongly rejects references like branch_0.count_0 against a code-built CTE query
    # (pipeline_v2's split_cte / pre_agg strategies). Those CTEs are fully code-generated and
    # trusted — the outer query only references aliases they define — so for a query WITH a
    # CTE we still qualify tables + run the blocked-column check below, but skip the
    # column-existence validation that the CTE structure defeats.
    has_cte = tree.find(exp.With) is not None
    try:
        qualified = qualify(tree, schema=schema, validate_qualify_columns=not has_cte)
    except OptimizeError as e:
        return ValidationResult(
            is_valid=False,
            errors=[ValidationError(ValidationErrorType.UNKNOWN_COLUMN, str(e))],
        )

    blocked = _blocked_columns_for_entities(session, entity_ids)
    for column in qualified.find_all(exp.Column):
        table_name = column.table
        col_name = column.name
        if (table_name, col_name) in blocked:
            errors.append(
                ValidationError(
                    ValidationErrorType.BLOCKED_COLUMN,
                    f"Column '{table_name}.{col_name}' is not exposed to the agent (PII or unexposed)",
                )
            )

    if errors:
        return ValidationResult(is_valid=False, errors=errors)

    if qualified.args.get("limit") is None:
        qualified = qualified.limit(limit)

    return ValidationResult(is_valid=True, sql=qualified.sql())
