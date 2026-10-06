"""Ours: the last check before pipeline v4's SQL reaches Dremio (src/pipeline_v4/dremio.py AsyncDremio._job),
the v4 counterpart of query_execution.execute_and_check's for v3.

v4 compiles SQL from a catalog already filtered for the role (pipeline_v4/catalog.load_catalog), so this should
never fire. It is here because a compiler bug must not become a data leak: the text must be one read-only
statement (services/sql_safety.py) and must not name a table the current role may not query.
"""

from src.database.mongodb import get_mongo_db
from src.services.query_execution import _forbidden_table_in
from src.services.sql_safety import check_read_only_sql

_EXPLAIN = "EXPLAIN PLAN FOR "


def refusal(sql: str) -> str | None:
    """Why `sql` must not run for the current role, or None."""
    statement = sql[len(_EXPLAIN):] if sql.startswith(_EXPLAIN) else sql
    reason = check_read_only_sql(statement, dialect="dremio")
    if reason:
        return f"refused: {reason}"
    forbidden = _forbidden_table_in(get_mongo_db(), statement)
    if forbidden:
        return f"access denied: table '{forbidden}' is not available to this role"
    return None
