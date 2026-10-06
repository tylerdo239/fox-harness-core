"""The read-only guard accepts Dremio JSON casts but still rejects writes hidden anywhere."""

from src.services.sql_safety import _mask_row_casts, check_read_only_sql

INTENT = ("SELECT workflow_id, COUNT(*) AS n FROM \"agents_db\".\"workflows_db\".\"workflow_nodes\" "
          "WHERE deleted_at IS NULL AND node_type = 'assistant' "
          "AND (TRY_CONVERT_FROM(config AS ROW(is_intent_node BOOLEAN))).is_intent_node = TRUE "
          "GROUP BY workflow_id ORDER BY n DESC")


def test_json_casts_written_by_hand_pass() -> None:
    assert check_read_only_sql(INTENT, dialect="dremio") is None


def test_the_pipelines_quoted_form_passes() -> None:
    sql = ('SELECT COUNT(*) FROM "s"."t" AS "t0" WHERE '
           '(TRY_CONVERT_FROM("t0"."config" AS ROW("a" ROW("b" VARCHAR))))."a"."b" = \'x\'')
    assert check_read_only_sql(sql, dialect="dremio") is None


def test_masking_respects_nesting_and_strings() -> None:
    masked, parts = _mask_row_casts("SELECT (CONVERT_FROM(c AS ROW(\"x)\" INT))).\"x)\" FROM t WHERE y = ')'")
    assert masked == "SELECT (__row_cast_0__).\"x)\" FROM t WHERE y = ')'"
    assert parts == ['CONVERT_FROM(c AS ROW("x)" INT))']


def test_writes_are_still_rejected() -> None:
    assert check_read_only_sql("DELETE FROM t", dialect="dremio") is not None
    hidden = "SELECT (TRY_CONVERT_FROM((DELETE FROM t) AS ROW(a INT))).a FROM t"
    assert "DELETE" in (check_read_only_sql(hidden, dialect="dremio") or "")
    assert check_read_only_sql(INTENT + "; DROP TABLE x", dialect="dremio") is not None
