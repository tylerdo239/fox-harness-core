"""Smoke test for the Python side of Data Studio's MongoDB layer (docs/data-studio-mongodb-plan.md).

Runs against a REAL MongoDB in a throw-away database that is dropped at the end. No LLM, Dremio,
Meilisearch or embedding endpoint is needed — those are replaced by small fakes, so what is
exercised is exactly the code that changed: sync, profiling, reindex, retrieval loaders, name
resolution, join planning, SQL building/validation, and chart persistence.

    docker compose -f docker-compose.yml up -d mongo
    cd packages/tool/data-studio-agent/python && uv run python tests/smoke_mongo.py

MONGODB_URL defaults to mongodb://localhost:27017.
"""

import asyncio
import os
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

DB_NAME = f"fox_ds_pysmoke_{uuid.uuid4().hex[:8]}"
os.environ["MONGODB_DATABASE_NAME"] = DB_NAME
os.environ.pop("MongoDBWrite", None)
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "bridge"))

from src.crud_mongo import entity as entity_crud  # noqa: E402
from src.crud_mongo import entity_column as column_crud  # noqa: E402
from src.crud_mongo import relationship as relationship_crud  # noqa: E402
from src.database.mongodb import ensure_indexes, get_mongo_db, mongo_client  # noqa: E402
from src.pipeline_v2.state import MetricSpec, PipelineState  # noqa: E402
from src.pipeline_v2.step6_joins import run_step6  # noqa: E402
from src.pipeline_v2.templates import build_sql_ast  # noqa: E402
from src.pipeline_v3.resolve import NameResolver  # noqa: E402
from src.services.dremio_sync import sync_dremio_metadata  # noqa: E402
from src.services.embedding_index import reindex_all  # noqa: E402
from src.services.profiling import profile_all_entities  # noqa: E402
from src.services.schema_linking import RetrievalResult, _load_candidate_entities, _load_join_keys  # noqa: E402
from src.services.sql_validator import validate_sql  # noqa: E402

step = 0


def ok(message: str) -> None:
    global step
    step += 1
    print(f"  ok {step}. {message}")


class FakeDremio:
    """Just enough of the catalog API for sync_dremio_metadata, plus run_sql for profiling."""

    def __init__(self) -> None:
        self.orders_fields = ["order_id", "customer_id", "total"]

    def list_sources(self):
        return self.list_containers(("SOURCE",))

    def list_containers(self, container_types):
        # top-level catalog entries, as DremioClient.list_containers (SOURCE databases, SPACE views)
        return [e for e in [{"id": "s1", "path": ["src"], "containerType": "SOURCE"}] if e["containerType"] in container_types]

    def get_catalog_entry(self, entry_id):
        if entry_id == "s1":
            return {"name": "src", "type": "MYSQL", "config": {"database": "db"},
                    "children": [{"containerType": "FOLDER", "path": ["src", "db"], "id": "f1"}]}
        if entry_id == "f1":
            return {"children": [{"type": "DATASET", "id": "t_orders"}, {"type": "DATASET", "id": "t_customers"}]}
        name = "orders" if entry_id == "t_orders" else "customers"
        fields = self.orders_fields if name == "orders" else ["customer_id", "name"]
        return {"path": ["src", "db", name], "fields": [{"name": f, "type": {"name": "INTEGER"}} for f in fields]}

    def run_sql(self, sql, timeout_sec=60):
        if sql.startswith("SELECT DISTINCT"):
            return [{"val": 1}, {"val": 2}]
        row = {"total_rows": 10}
        for token in sql.replace(",", " ").split():
            if token.endswith('__non_null"'):
                row[token.split(" AS ")[-1].strip('"')] = 10
        # column stat aliases look like "<col>__non_null" / __distinct / __min / __max
        import re
        for col in set(re.findall(r'"(\w+)__non_null"', sql)):
            row[f"{col}__non_null"], row[f"{col}__distinct"], row[f"{col}__min"], row[f"{col}__max"] = 10, 5, 1, 9
        return [row]


class FakeEmbedding:
    async def embed_documents(self, texts):
        return [[0.0, 0.1] for _ in texts]


class FakeStore:
    def __init__(self) -> None:
        self.upserts: dict[str, int] = {}

    def upsert(self, collection_name, ids, documents, embeddings, metadatas):
        assert all(isinstance(i, str) for i in ids), "search-index ids must be strings now"
        self.upserts[collection_name] = self.upserts.get(collection_name, 0) + len(ids)


def main() -> None:
    # This smoke test exercises the pipeline's machinery over the whole catalog, so it runs as admin;
    # what role `user` may see is covered by tests/role_authz_test.py.
    from src.security import role as role_mod

    role_mod.set_role(role_mod.ADMIN)
    db = get_mongo_db()
    dremio = FakeDremio()

    ensure_indexes(db)
    ensure_indexes(db)
    ok(f"connected, indexes ensured twice (database {DB_NAME})")

    # sync ---------------------------------------------------------------------------------------
    summary = sync_dremio_metadata(dremio, db)
    assert summary["sources"] == 1 and summary["entities_added"] == 2, summary
    orders = entity_crud.get_by_physical_name(db, db["data_sources"].find_one({})["_id"], "orders")
    assert isinstance(orders.id, str) and len(orders.id) == 36
    assert orders["entity_type"] == "table" and db["data_sources"].find_one({})["status"] == "connected"
    ok("dremio sync creates uuid-string ids and stores enums as values")

    dremio.orders_fields = ["order_id", "customer_id", "status"]  # 'total' vanished, 'status' appeared
    sync_dremio_metadata(dremio, db)
    cols = {c["physical_name"]: c for c in column_crud.list_by_entity_all(db, orders.id)}
    assert cols["total"]["is_deprecated"] is True and cols["status"]["is_deprecated"] is False
    assert sync_dremio_metadata(dremio, db)["entities_added"] == 0
    ok("second sync soft-deletes a vanished column, adds the new one, and is idempotent")

    # profiling ----------------------------------------------------------------------------------
    results = profile_all_entities(dremio, db)
    assert len(results) == 2 and all("error" not in r for r in results), results
    profiled = column_crud.get_by_entity_and_name(db, orders.id, "order_id")
    assert profiled["sample_values"] == [1, 2] and profiled["distinct_count"] == 5
    assert entity_crud.get_by_id(db, orders.id)["row_count_est"] == 10
    ok("profiling writes sample_values / stats / row_count_est")

    # curation (what the admin UI does) ------------------------------------------------------------
    customers = entity_crud.get_by_physical_name(db, orders["data_source_id"], "customers")
    o_id = column_crud.get_by_entity_and_name(db, orders.id, "order_id")
    o_cust = column_crud.get_by_entity_and_name(db, orders.id, "customer_id")
    c_id = column_crud.get_by_entity_and_name(db, customers.id, "customer_id")
    c_name = column_crud.get_by_entity_and_name(db, customers.id, "name")
    column_crud.update(db, o_id.id, role="key", semantic_type="id")
    column_crud.update(db, c_id.id, role="key", semantic_type="id")
    column_crud.update(db, c_name.id, role="dimension", semantic_type="text")
    rel = relationship_crud.create(db, from_entity_id=customers.id, to_entity_id=orders.id,
                                   cardinality="1:N", join_type_default="left", is_curated=True)
    relationship_crud.create_column_pair(db, relationship_id=rel.id, from_column_id=c_id.id,
                                         to_column_id=o_cust.id, seq=0)
    assert column_crud.best_label_column(db, customers.id).id == c_name.id
    ok("curation + relationship stored; best_label_column picks the text dimension")

    # retrieval loaders + name resolution ------------------------------------------------------------
    candidates = _load_candidate_entities(db, [orders.id, customers.id])
    assert {c.display_name for c in candidates} == {"orders", "customers"}
    join_keys = _load_join_keys(db, [orders.id, customers.id])
    assert len(join_keys) == 1 and join_keys[0].from_entity_id == customers.id
    resolver = NameResolver.from_retrieval(RetrievalResult(entities=candidates, glossary_terms=[], join_keys=join_keys), db)
    assert resolver.entity("orders") == orders.id
    assert resolver.column("orders.order_id") == o_id.id
    assert resolver.column("customers.customer_id") == c_id.id
    ok("candidate loaders, join keys and NameResolver work with string ids")

    # join planning + SQL ----------------------------------------------------------------------------
    state = PipelineState(question="đếm đơn theo khách")
    state.grain_entity_id = customers.id
    state.target_entity_ids = {customers.id, orders.id}
    state.metrics = [MetricSpec(agg="count_distinct", expr_column_id=o_id.id, alias="order_count")]
    state.select_column_ids = [c_name.id]
    state.group_by_column_ids = [c_name.id]
    run_step6(db, state)
    assert state.join_plan is not None and len(state.join_plan.edges) == 1
    ast = build_sql_ast(db, state)
    validation = validate_sql(db, ast, [customers.id, orders.id])
    assert validation.is_valid, validation.errors
    assert "JOIN" in validation.sql.upper() and "COUNT(DISTINCT" in validation.sql.upper(), validation.sql
    ok(f"join planning -> AST -> validated SQL: {validation.sql[:90]}...")

    # PII / unexposed columns must be blocked --------------------------------------------------------
    column_crud.update(db, c_name.id, is_pii=True)
    blocked = validate_sql(db, build_sql_ast(db, state), [customers.id, orders.id])
    assert not blocked.is_valid and "not exposed" in blocked.errors[0].message
    ok("validator blocks a PII column")

    # reindex ----------------------------------------------------------------------------------------
    store = FakeStore()
    indexed = asyncio.run(reindex_all(db, FakeEmbedding(), store))
    assert indexed["entities"] == 2 and store.upserts["entities"] == 2
    assert entity_crud.get_by_id(db, orders.id)["embed_text"]
    ok("reindex embeds exposed entities/columns and passes string ids to the search index")

    # chart persistence (bridge/runner.py) -----------------------------------------------------------
    import runner  # bridge/runner.py — module-level imports only, main() does not run

    result = SimpleNamespace(answer_markdown="ok", sql="select 1", row_count=1, rows=[{"a": 1}])
    chart_id = runner._persist_chart(db, "câu hỏi", result, {"type": "bar", "title": "t", "x": "a", "y": ["b"], "rows": [{"a": 1}]})
    assert isinstance(chart_id, str)
    chart = db["charts"].find_one({"_id": chart_id})
    assert chart["y_json"] == ["b"] and db["query_results"].find_one({"_id": chart["query_result_id"]})
    assert runner._persist_chart(db, "q", result, None) is None
    ok("chart persistence writes conversation -> message -> query_result -> chart with string ids")

    # several charts share ONE chain; charts of a decomposed answer are found on its sub-results
    multi = SimpleNamespace(
        answer_markdown="ok", sql="select 1", row_count=1, rows=[{"a": 1}], charts=[],
        sub_results=[{"charts": [{"type": "pie", "x": "a", "y": ["b"], "rows": []}, {"type": "table"}]},
                     {"charts": [{"type": "bar", "x": "a", "y": ["b"], "rows": [{"a": 1}]}]}],
    )
    visual = runner._answer_charts(multi)
    assert [c["type"] for c in visual] == ["pie", "bar", "table"], visual  # tables kept, last
    ids = runner._persist_charts(db, "nhiều biểu đồ", multi, visual)
    docs = [db["charts"].find_one({"_id": i}) for i in ids]
    assert len(ids) == 3 and len({d["query_result_id"] for d in docs}) == 1 and [d["type"] for d in docs] == ["pie", "bar", "table"]
    assert runner._persist_charts(db, "q", multi, []) == []
    ok("several charts share one chain (ids in order); decomposed answers expose their sub-result charts")

    print(f"\nPASS — {step} checks")


try:
    main()
except Exception:
    import traceback

    traceback.print_exc()
    print("\nFAIL")
    sys.exit(1)
finally:
    mongo_client.drop_database(DB_NAME)
