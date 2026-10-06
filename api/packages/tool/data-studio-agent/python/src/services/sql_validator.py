from dataclasses import dataclass, field
from enum import StrEnum

import sqlglot
from sqlglot import exp
from sqlglot.errors import OptimizeError, ParseError
from sqlglot.optimizer.qualify import qualify

import re

from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as entity_column_crud
from src.database.mongodb import AttrDatabase
from src.services.sql_safety import check_read_only_sql, find_write_violation
from src.security import role as role_mod

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


def _full_catalog(db: AttrDatabase, entity_ids: list[str]):
    """The referenced entities and ALL their non-deprecated columns, read as admin: the validator must see
    what exists in order to judge what the caller's role may touch (a role-filtered read would make a
    forbidden column look merely "unknown", and the CTE path below skips unknown-column checks)."""
    with role_mod.as_role(role_mod.ADMIN):
        entities = entity_crud.list_by_ids(db, entity_ids)
        columns = entity_column_crud.list_by_entity_ids(db, [e.id for e in entities])
    return entities, columns


def build_schema_for_entities(db: AttrDatabase, entity_ids: list[str]) -> dict:
    """Build a SQLGlot-shaped schema dict {catalog: {db: {table: {col: type}}}}
    scoped to the given entities, using only real physical names from our catalog."""
    schema: dict = {}
    entities, columns = _full_catalog(db, entity_ids)
    by_entity: dict[str, dict[str, str]] = {}
    for col in columns:
        by_entity.setdefault(col.entity_id, {})[col.physical_name] = col.data_type
    for entity in entities:
        path_parts = entity.physical_path.split(".")
        if len(path_parts) != 3:
            continue
        catalog, database, table = path_parts
        cols = by_entity.get(entity.id)
        if cols:  # sqlglot rejects a table with no columns
            schema.setdefault(catalog, {}).setdefault(database, {})[table] = cols
    return schema


def _blocked_columns_for_entities(db: AttrDatabase, entity_ids: list[str], role: str = role_mod.ADMIN) -> set[tuple[str, str]]:
    """Returns {(table_physical_PATH, column_physical_name)} for columns this role must never reach: not
    exposed, PII (for every role), or — for role user — not opted in for users (src/security/role.py).
    Keyed by the full physical path, not the bare table name, so an alias cannot dodge it."""
    entities, columns = _full_catalog(db, entity_ids)
    entities_by_id = {e.id: e for e in entities}
    blocked = set()
    for col in columns:
        entity = entities_by_id.get(col.entity_id)
        if entity is None:
            continue
        if not col.is_exposed or col.is_pii or not role_mod.doc_allowed(col, role) or not role_mod.doc_allowed(entity, role):
            blocked.add((entity.physical_path, col.physical_name))
    return blocked


def _allowed_table_paths(db: AttrDatabase, entity_ids: list[str], role: str = role_mod.ADMIN) -> set[str]:
    """Physical paths of the referenced entities that this role may query."""
    entities, _ = _full_catalog(db, entity_ids)
    return {e.physical_path for e in entities if role_mod.doc_allowed(e, role)}


def _table_path(table: exp.Table) -> str:
    return ".".join(p for p in (table.catalog, table.db, table.name) if p)


_IDENT = re.compile(r'"([^"]+)"|\b([A-Za-z_][A-Za-z0-9_]*)\b')


def validate_sql(
    db: AttrDatabase,
    sql: str | exp.Select,
    entity_ids: list[str],
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
        # parse_one silently keeps only the first of several statements, so reject
        # multi-statement input (e.g. 'SELECT 1; DROP TABLE x') before parsing it (reference sql_safety)
        read_only_error = check_read_only_sql(sql)
        if read_only_error:
            return ValidationResult(
                is_valid=False,
                errors=[ValidationError(ValidationErrorType.NOT_SELECT_ONLY, read_only_error)],
            )
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

    # A SELECT can still carry a write (SELECT ... INTO, a DML subquery, a raw fragment): refuse those too.
    write_violation = find_write_violation(tree)
    if write_violation:
        return ValidationResult(
            is_valid=False,
            errors=[ValidationError(ValidationErrorType.NOT_SELECT_ONLY, write_violation)],
        )

    role = role_mod.current()
    allowed_paths = _allowed_table_paths(db, entity_ids, role)
    for table in tree.find_all(exp.Table):
        table_path = _table_path(table)
        if table_path not in allowed_paths:
            errors.append(
                ValidationError(
                    ValidationErrorType.UNKNOWN_TABLE,
                    f"Table '{table_path}' is not in the allowed entity list",
                )
            )

    if errors:
        return ValidationResult(is_valid=False, errors=errors)

    schema = build_schema_for_entities(db, entity_ids)
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

    blocked = _blocked_columns_for_entities(db, entity_ids, role)
    # Which physical table(s) each name a column can be qualified with refers to — its alias or its bare
    # name. qualify() rewrites every column to `<alias>.<col>`, so comparing that against a table's
    # physical NAME (the old check) let any aliased table through. A name bound to several tables (two
    # scopes reusing an alias) is checked against all of them.
    by_name: dict[str, set[str]] = {}
    for table in qualified.find_all(exp.Table):
        path = _table_path(table)
        by_name.setdefault(table.alias_or_name, set()).add(path)
    for column in qualified.find_all(exp.Column):
        for path in by_name.get(column.table, set()):
            if (path, column.name) in blocked:
                errors.append(
                    ValidationError(
                        ValidationErrorType.BLOCKED_COLUMN,
                        f"Column '{column.table}.{column.name}' is not exposed to role '{role}' (PII, unexposed, or not opted in for this role)",
                    )
                )
                break

    if role != role_mod.ADMIN:
        # A star that survived qualification (it could not be expanded against the schema) would return
        # columns nobody checked.
        if any(isinstance(star.parent, exp.Select) or isinstance(star.parent, exp.Column) for star in qualified.find_all(exp.Star)):
            errors.append(ValidationError(ValidationErrorType.BLOCKED_COLUMN, "SELECT * is not allowed for role 'user'"))
        # Raw Dremio fragments the generator embeds as exp.Var (glossary filters) are opaque to the checks
        # above: refuse any that names a blocked column of a table in this query, or a table this role
        # may not query at all.
        in_query = {path for paths in by_name.values() for path in paths}
        blocked_names = {col for (path, col) in blocked if path in in_query}
        with role_mod.as_role(role_mod.ADMIN):
            hidden_tables = {e.physical_name for e in entity_crud.list_exposed_active(db) if not role_mod.doc_allowed(e, role)}
        for var in qualified.find_all(exp.Var):
            tokens = {a or b for a, b in _IDENT.findall(var.name or "")}
            hit = tokens & (blocked_names | hidden_tables)
            if hit:
                errors.append(
                    ValidationError(
                        ValidationErrorType.BLOCKED_COLUMN,
                        f"An expression references {sorted(hit)[0]!r}, which is not available to role '{role}'",
                    )
                )
                break

    if errors:
        return ValidationResult(is_valid=False, errors=errors)

    if qualified.args.get("limit") is None:
        qualified = qualified.limit(limit)

    return ValidationResult(is_valid=True, sql=qualified.sql())
