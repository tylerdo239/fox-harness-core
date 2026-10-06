"""Read-only guard: only SELECT-style queries may reach Dremio.

Checking the root node alone isn't enough — a statement can be a SELECT at the top and still
write, e.g. `SELECT * INTO t2 FROM t` (exp.Into) or `WITH d AS (DELETE ... RETURNING *) SELECT
...` (exp.Delete inside a CTE). So the whole tree is walked for write/DDL/session nodes.
Glossary expressions are embedded as opaque exp.Var text the parser never looks at, so their
text gets a keyword scan as well, like Dremio's JSON casts (TRY_CONVERT_FROM … AS ROW), which
are masked before parsing.
"""

import re

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

# Anything that changes data, schema, permissions or session state. exp.DML / exp.DDL cover
# Insert/Update/Delete/Merge/Copy/Create; the rest don't share a base class. exp.Command is
# what SQLGlot falls back to for statements it can't parse (VACUUM, OPTIMIZE, ...), so it's
# rejected too.
_WRITE_NODE_TYPES: tuple[type[exp.Expression], ...] = (
    exp.DML,
    exp.DDL,
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Copy,
    exp.Create,
    exp.Drop,
    exp.Alter,
    exp.TruncateTable,
    exp.Into,
    exp.LoadData,
    exp.Grant,
    exp.Revoke,
    exp.Refresh,
    exp.Cache,
    exp.Uncache,
    exp.Use,
    exp.Set,
    exp.Pragma,
    exp.Analyze,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
    exp.Command,
)

_WRITE_KEYWORDS_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE\s+INTO|DROP|CREATE|ALTER|TRUNCATE|GRANT|"
    r"REVOKE|COPY|REFRESH|VACUUM|OPTIMIZE|CALL|EXEC|EXECUTE|USE|SET|COMMIT|ROLLBACK)\b",
    re.IGNORECASE,
)
_STRING_LITERAL_RE = re.compile(r"'(?:[^']|'')*'")


def find_write_violation(tree: exp.Expression) -> str | None:
    """Returns a reason string if the AST is not a pure read query, else None."""
    if not isinstance(tree, exp.Query):
        return f"Only SELECT statements are allowed, got {type(tree).__name__}"

    for node in tree.walk():
        if isinstance(node, _WRITE_NODE_TYPES):
            return f"Write/DDL operation is not allowed: {type(node).__name__}"
        if isinstance(node, exp.Var) and isinstance(node.this, str):
            reason = _scan_raw_fragment(node.this)
            if reason:
                return reason
    return None


def check_read_only_sql(sql: str, dialect: str | None = None) -> str | None:
    """Parses raw SQL and returns a reason string if it isn't a single read-only query.
    SQL that can't be parsed is rejected, since it can't be verified.

    Dremio's `TRY_CONVERT_FROM(col AS ROW(field TYPE))` (reading a JSON text column) is not
    something the parser knows, so each such call is replaced by a placeholder name before
    parsing; the cut-out text still gets the write-keyword scan."""
    masked, fragments = _mask_row_casts(sql)
    for fragment in fragments:
        reason = _scan_raw_fragment(fragment)
        if reason:
            return reason
    try:
        statements = [s for s in sqlglot.parse(masked, read=dialect) if s is not None]
    except ParseError as e:
        return f"Could not parse SQL to verify it is read-only: {e}"

    if len(statements) != 1:
        return f"Exactly one statement is allowed, got {len(statements)}"
    return find_write_violation(statements[0])


_ROW_CAST_START_RE = re.compile(r"\b(?:TRY_)?CONVERT_FROM\s*\(", re.IGNORECASE)
_AS_ROW_RE = re.compile(r"\bAS\s+ROW\s*\(", re.IGNORECASE)


def _call_end(sql: str, open_paren: int) -> int | None:
    """Index just past the parenthesis matching sql[open_paren], skipping quoted text."""
    depth, i, quote = 0, open_paren, None
    while i < len(sql):
        ch = sql[i]
        if quote:
            if ch == quote:
                if i + 1 < len(sql) and sql[i + 1] == quote:  # doubled quote inside a literal
                    i += 1
                else:
                    quote = None
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def _mask_row_casts(sql: str) -> tuple[str, list[str]]:
    """Replace every (TRY_)CONVERT_FROM(... AS ROW(...)) call with a placeholder identifier."""
    out: list[str] = []
    fragments: list[str] = []
    pos = 0
    for match in _ROW_CAST_START_RE.finditer(sql):
        if match.start() < pos:  # inside a call already masked
            continue
        end = _call_end(sql, match.end() - 1)
        if end is None:
            break
        call = sql[match.start():end]
        if not _AS_ROW_RE.search(call):
            continue
        out.append(sql[pos:match.start()])
        out.append(f"__row_cast_{len(fragments)}__")
        fragments.append(call)
        pos = end
    out.append(sql[pos:])
    return "".join(out), fragments


def _scan_raw_fragment(text: str) -> str | None:
    """Keyword scan for opaque SQL fragments (glossary expressions). String literals are
    stripped first so values like 'DELETED' don't trip it."""
    stripped = _STRING_LITERAL_RE.sub("''", text)
    if ";" in stripped:
        return "Statement separator ';' is not allowed inside an expression"
    match = _WRITE_KEYWORDS_RE.search(stripped)
    if match:
        return f"Write/DDL keyword '{match.group(1).upper()}' is not allowed inside an expression"
    return None
