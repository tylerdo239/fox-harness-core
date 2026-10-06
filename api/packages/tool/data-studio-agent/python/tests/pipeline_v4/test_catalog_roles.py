"""Ours: pipeline v4 under roles — load_catalog keeps only what role `user` may query (allowed_roles, never PII),
drops what is built on the rest, and sql_gate refuses SQL naming a table the role may not query."""

import asyncio
from typing import Any

import pytest

from src.data_profile.glossary import COLLECTION as GLOSSARY
from src.data_profile.metrics import COLLECTION as METRICS
from src.pipeline_v4 import dremio as v4_dremio
from src.pipeline_v4.catalog import load_catalog
from src.security import role as role_mod
from src.security import sql_gate
from tests.pipeline_v4.test_catalog import Collection

BOTH = ["admin", "user"]


def _table(tid: str, roles: list[str], **profile: Any) -> dict[str, Any]:
    return {"_id": tid, "data_source_id": "src", "physical_path": f"s.{tid}", "physical_name": tid, "is_deprecated": False,
            "is_exposed": True, "allowed_roles": roles, "profile": profile}


def _col(cid: str, eid: str, roles: list[str], pii: bool = False) -> dict[str, Any]:
    return {"_id": cid, "entity_id": eid, "physical_name": cid, "data_type": "VARCHAR", "is_deprecated": False,
            "is_exposed": True, "allowed_roles": roles, "is_pii": pii}


def _db() -> dict[str, Collection]:
    return {
        "data_sources": Collection([{"_id": "src", "deleted_at": None}]),
        "entities": Collection([
            _table("open", BOTH),
            _table("closed", ["admin"]),
            # its always-applied filter is on an admin-only column: without it counts would be wrong
            _table("filtered", BOTH, default_filters=[{"column_id": "f_secret", "op": "=", "values": ["x"]}]),
        ]),
        "entity_columns": Collection([
            _col("o_id", "open", BOTH), _col("o_amount", "open", BOTH), _col("o_cost", "open", ["admin"]),
            _col("o_phone", "open", BOTH, pii=True),
            _col("c_id", "closed", BOTH),
            _col("f_id", "filtered", BOTH), _col("f_secret", "filtered", ["admin"]),
        ]),
        "relationships": Collection([
            {"_id": "r_open_closed", "from_entity_id": "open", "to_entity_id": "closed", "deleted_at": None},
            {"_id": "r_open_self", "from_entity_id": "open", "to_entity_id": "open", "deleted_at": None},
            {"_id": "r_hidden_key", "from_entity_id": "open", "to_entity_id": "open", "deleted_at": None},
        ]),
        "relationship_column_pairs": Collection([
            {"_id": "p1", "relationship_id": "r_open_closed", "from_column_id": "o_id", "to_column_id": "c_id", "deleted_at": None},
            {"_id": "p2", "relationship_id": "r_open_self", "from_column_id": "o_id", "to_column_id": "o_id", "deleted_at": None},
            {"_id": "p3", "relationship_id": "r_hidden_key", "from_column_id": "o_cost", "to_column_id": "o_id", "deleted_at": None},
        ]),
        METRICS: Collection([
            {"_id": "m_amount", "name": "amount", "kind": "aggregate", "entity_id": "open", "column_id": "o_amount", "deleted_at": None},
            {"_id": "m_cost", "name": "cost", "kind": "aggregate", "entity_id": "open", "column_id": "o_cost", "deleted_at": None},
            {"_id": "m_filter", "name": "x", "kind": "aggregate", "entity_id": "open", "deleted_at": None,
             "filters": [{"column_id": "o_cost", "op": ">", "values": ["0"]}]},
            {"_id": "m_closed", "name": "c", "kind": "aggregate", "entity_id": "closed", "deleted_at": None},
            {"_id": "m_ratio", "name": "margin", "kind": "ratio", "numerator_metric_id": "m_amount",
             "denominator_metric_id": "m_cost", "deleted_at": None},
        ]),
        GLOSSARY: Collection([
            {"_id": "g_ok", "term": "ok", "kind": "definition", "deleted_at": None},
            {"_id": "g_segment", "term": "big", "kind": "segment", "entity_id": "open", "deleted_at": None,
             "filters": [{"column_id": "o_cost", "op": ">", "values": ["9"]}]},
            {"_id": "g_metric", "term": "m", "kind": "metric", "metric_id": "m_cost", "deleted_at": None},
        ]),
    }


def _load(role: str):
    with role_mod.as_role(role):
        return asyncio.run(load_catalog(_db()))  # type: ignore[arg-type]


def _saved(cat) -> set[str]:
    return {k for k in cat.metrics if not k.startswith("builtin:")}


def test_user_sees_only_what_was_opened_to_it() -> None:
    cat = _load(role_mod.USER)
    assert set(cat.tables) == {"open"}                       # closed: admin-only; filtered: filter on a hidden column
    assert set(cat.columns) == {"o_id", "o_amount"}          # o_cost admin-only, o_phone PII
    assert [j.id for j in cat.joins] == ["r_open_self"]      # to a hidden table / on a hidden key: gone
    assert _saved(cat) == {"m_amount"}                       # cost, its filter, the closed table, the ratio on cost
    assert set(cat.glossary) == {"g_ok"}


def test_admin_catalog_is_unchanged() -> None:
    cat = _load(role_mod.ADMIN)
    assert set(cat.tables) == {"open", "closed", "filtered"}
    assert {"o_cost", "o_phone", "f_secret"} <= set(cat.columns)
    assert _saved(cat) == {"m_amount", "m_cost", "m_filter", "m_closed", "m_ratio"}
    assert set(cat.glossary) == {"g_ok", "g_segment", "g_metric"}


def test_sql_gate_refuses_writes_and_forbidden_tables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sql_gate, "get_mongo_db", lambda: None)
    monkeypatch.setattr(sql_gate, "_forbidden_table_in",
                        lambda db, sql: "s.closed" if "closed" in sql else None)
    assert sql_gate.refusal('SELECT COUNT(*) FROM "s"."open"') is None
    assert sql_gate.refusal('EXPLAIN PLAN FOR SELECT COUNT(*) FROM "s"."open"') is None
    assert "access denied" in (sql_gate.refusal('SELECT * FROM "s"."closed"') or "")
    assert "refused" in (sql_gate.refusal('DELETE FROM "s"."open"') or "")
    assert "refused" in (sql_gate.refusal('SELECT 1; DROP TABLE x') or "")


def test_async_dremio_never_sends_a_refused_query(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(v4_dremio.sql_gate, "refusal", lambda sql: "access denied: table 's.closed'")

    class NoHttp:
        async def post(self, *a: Any, **k: Any) -> None:
            raise AssertionError("reached Dremio")

    client = v4_dremio.AsyncDremio.__new__(v4_dremio.AsyncDremio)
    with pytest.raises(v4_dremio.DremioError, match="access denied"):
        asyncio.run(client._job(NoHttp(), "SELECT * FROM s.closed", 5))  # type: ignore[arg-type]
