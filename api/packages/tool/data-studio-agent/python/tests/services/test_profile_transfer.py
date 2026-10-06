"""Profile export → import into another installation (other ids) → the same profile, on in-memory Mongo."""

from typing import Any

import mongomock

from src.crud_mongo import data_source as ds_crud
from src.crud_mongo import entity as entity_crud
from src.crud_mongo import entity_column as column_crud
from src.data_profile import glossary as glossary_service
from src.data_profile import metrics as metric_service
from src.data_profile import relationships as rel_service
from src.data_profile import service, transfer
from src.data_profile.glossary import GlossaryInput
from src.data_profile.metrics import MetricInput
from src.data_profile.models import (
    ColumnProfile,
    EntityProfile,
    JsonField,
    TypedFilter,
    ValueCatalogItem,
)
from src.data_profile.relationships import PairInput, RelationshipInput
from src.database.mongodb import AttrDatabase


def install() -> tuple[AttrDatabase, dict[str, Any]]:
    """Sources, tables and columns as the Dremio import makes them (fresh ids, empty profiles)."""
    db = AttrDatabase(mongomock.MongoClient()["db"])
    src = ds_crud.create(db, name="shop", source_type="mysql", dremio_path="shop", status="connected")
    ids: dict[str, Any] = {"source": src}
    for table, cols in (("orders", [("order_id", "INTEGER"), ("customer_id", "INTEGER"), ("status", "VARCHAR"),
                                    ("amount", "DOUBLE"), ("config", "VARCHAR")]),
                        ("customers", [("customer_id", "INTEGER"), ("name", "VARCHAR")])):
        e = entity_crud.create(db, data_source_id=src["_id"], physical_path=f"shop.{table}", physical_name=table,
                               entity_type="table", display_name=table)
        ids[table] = e["_id"]
        for i, (name, typ) in enumerate(cols):
            ids[f"{table}.{name}"] = column_crud.create(db, entity_id=e["_id"], physical_name=name, data_type=typ,
                                                        ordinal=i, display_name=name)["_id"]
    return db, ids


def curate(db: AttrDatabase, ids: dict[str, Any]) -> None:
    status = column_crud.get_by_id(db, ids["orders.status"])
    service.save_column(db, status, {"description": "trạng thái"}, ColumnProfile(
        value_catalog=[ValueCatalogItem(value="DONE", label="Hoàn tất")], value_catalog_complete=True))
    config = column_crud.get_by_id(db, ids["orders.config"])
    service.save_column(db, config, {}, ColumnProfile(json_fields=[JsonField(path="vip", data_type="BOOLEAN")]))
    service.save_entity(db, entity_crud.get_by_id(db, ids["orders"]), {"synonyms": ["đơn hàng"]}, EntityProfile(
        grain_key_column_ids=[ids["orders.order_id"]], label_column_id=ids["orders.status"],
        default_filters=[TypedFilter(column_id=ids["orders.status"], op="=", values=["DONE"]),
                         TypedFilter(column_id=f"{ids['orders.config']}#vip", op="is_not_null")]))
    rel_service.create(db, RelationshipInput(
        from_entity_id=ids["customers"], to_entity_id=ids["orders"], cardinality="1:N", join_type_default="left",
        pairs=[PairInput(from_column_id=ids["customers.customer_id"], to_column_id=ids["orders.customer_id"])]))
    n = metric_service.create(db, MetricInput(name="revenue", display_name="Doanh thu", entity_id=ids["orders"],
                                              aggregation="sum", column_id=ids["orders.amount"]))
    d = metric_service.create(db, MetricInput(name="order_count", display_name="Số đơn", entity_id=ids["orders"],
                                              aggregation="count"))
    metric_service.create(db, MetricInput(name="avg_order", display_name="Giá trị đơn TB", kind="ratio",
                                          numerator_metric_id=n["_id"], denominator_metric_id=d["_id"]))
    glossary_service.create(db, GlossaryInput(term="doanh số", definition="= doanh thu", kind="metric",
                                              metric_id=n["_id"]))
    glossary_service.create(db, GlossaryInput(term="đơn xong", definition="đơn đã hoàn tất", kind="segment",
                                              entity_id=ids["orders"],
                                              filters=[TypedFilter(column_id=ids["orders.status"], op="=", values=["DONE"])]))


def files(db: AttrDatabase, ids: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {"tables": transfer.export_tables(db, ids["source"]), "relationships": transfer.export_relationships(db),
            "metrics": transfer.export_metrics(db), "glossary": transfer.export_glossary(db)}


def same(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return {k: v for k, v in a.items() if k != "exported_at"} == {k: v for k, v in b.items() if k != "exported_at"}


def test_files_hold_names_not_ids() -> None:
    db, ids = install()
    curate(db, ids)
    f = files(db, ids)
    text = str(f)
    assert not any(str(v) in text for k, v in ids.items() if k != "source")
    orders = f["tables"]["tables"][1]
    assert orders["profile"]["grain_key_columns"] == ["order_id"]
    assert orders["profile"]["default_filters"][1]["column"] == "config#vip"
    ratio = next(m for m in f["metrics"]["metrics"] if m["name"] == "avg_order")
    assert (ratio["numerator_metric"], ratio["denominator_metric"]) == ("revenue", "order_count")


def test_another_installation_gets_the_same_profile() -> None:
    db, ids = install()
    curate(db, ids)
    exported = files(db, ids)
    other, other_ids = install()
    for kind in ("tables", "relationships", "metrics", "glossary"):
        fn = getattr(transfer, f"import_{kind}")
        args = (other, other_ids["source"]) if kind == "tables" else (other,)
        dry = fn(*args, exported[kind], True)
        assert dry.skipped == 0, dry.items
        report = fn(*args, exported[kind], False)
        assert report.skipped == 0, report.items
    again = files(other, other_ids)
    assert all(same(again[k], exported[k]) for k in exported)
    # importing again updates what is there, never duplicates
    report = transfer.import_metrics(other, exported["metrics"], False)
    assert (report.created, report.updated) == (0, 3)


def test_a_dry_run_writes_nothing_and_problems_skip_only_their_item() -> None:
    db, ids = install()
    curate(db, ids)
    exported = files(db, ids)
    other, other_ids = install()
    report = transfer.import_metrics(other, exported["metrics"], True)
    assert report.created == 3 and metric_service._all(other) == []          # ratio checked against planned ones
    report = transfer.import_glossary(other, exported["glossary"], False)   # metrics not imported yet
    assert [(i.name, i.action) for i in report.items] == [("doanh số", "skip"), ("đơn xong", "create")]
    assert "import the metrics first" in report.items[0].problems[0]
    exported["tables"]["tables"].append({"path": "shop.refunds", "name": "refunds", "columns": []})
    report = transfer.import_tables(other, other_ids["source"], exported["tables"], False)
    assert report.updated == 2 and report.items[-1].problems == [
        "no such table in this data source (import it from Dremio first)"]


def test_a_wrong_file_is_refused() -> None:
    db, _ = install()
    for bad in ({"kind": "metrics"}, transfer.export_glossary(db)):
        try:
            transfer.import_metrics(db, bad, True)
        except transfer.TransferError as err:
            assert "not a profile export" in str(err) or "holds glossary" in str(err)
        else:
            raise AssertionError("accepted a wrong file")
