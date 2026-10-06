"""A small hand-built catalog for the compiler's golden tests (no MongoDB, no Dremio).

sales.orders          fact, 1 row = 1 order, times stored in UTC, business time Asia/Ho_Chi_Minh,
                      default filter status = DONE, JSON column config with field is_online
sales.order_items     fact, 1 row = 1 product line (orders → items is one to many)
sales.branches        dim, label column branch_name, region with a complete value list
crm.customers         dim in another source, phone is personal data
sales.stock_daily     snapshot of stock per branch per day
"""

from src.data_profile.models import ColumnProfile, EntityProfile, RelationshipProfile
from src.pipeline_v4.catalog import Catalog, Column, Join, Table


def _table(tid, path, source, synonyms=(), **profile):
    return Table(id=tid, physical_path=path, physical_name=path.split(".")[-1], display_name=path.split(".")[-1],
                 data_source_id=source, profile=EntityProfile.model_validate(profile), synonyms=list(synonyms))


def _col(cid, eid, name, dtype, role=None, semantic=None, pii=False, **profile):
    return Column(id=cid, entity_id=eid, physical_name=name, display_name=name, data_type=dtype, role=role,
                  semantic_type=semantic, profile=ColumnProfile.model_validate(profile), is_pii=pii)


def build_catalog() -> Catalog:
    cat = Catalog()
    for t in [
        _table("orders", "sales.orders", "src_sales", ["đơn hàng"], table_kind="fact", grain_key_column_ids=["o_id"],
               time_column_id="o_date", business_tz="Asia/Ho_Chi_Minh", storage_tz="UTC",
               default_filters=[{"column_id": "o_status", "op": "=", "values": ["DONE"]}],
               list_filters=[{"column_id": "o_test", "op": "=", "values": ["false"]}]),
        _table("items", "sales.order_items", "src_sales", table_kind="fact", grain_key_column_ids=["i_order", "i_line"]),
        _table("branches", "sales.branches", "src_sales", ["chi nhánh", "cửa hàng"], table_kind="dim", grain_key_column_ids=["b_id"],
               label_column_id="b_name"),
        _table("customers", "crm.customers", "src_crm", ["khách hàng"], table_kind="dim", grain_key_column_ids=["c_id"],
               label_column_id="c_name"),
        _table("stock", "sales.stock_daily", "src_sales", table_kind="snapshot", snapshot_column_id="s_date",
               time_column_id="s_date", grain_key_column_ids=["s_date", "s_branch"]),
    ]:
        cat.tables[t.id] = t

    region_values = [{"value": "MB", "label": "Miền Bắc"}, {"value": "MN", "label": "Miền Nam"}]
    status_values = [{"value": "DONE", "label": "Hoàn tất"}, {"value": "CANCELLED", "label": "Đã hủy"}]
    cols = [
        _col("o_id", "orders", "order_id", "VARCHAR", "key", "id"),
        _col("o_branch", "orders", "branch_id", "VARCHAR", "key", "id"),
        _col("o_customer", "orders", "customer_id", "VARCHAR", "key", "id"),
        _col("o_date", "orders", "order_date", "TIMESTAMP", "dimension", "datetime"),
        _col("o_status", "orders", "status", "VARCHAR", "dimension", "category",
             value_catalog=status_values, value_catalog_complete=True),
        _col("o_amount", "orders", "net_amount", "DECIMAL", "measure", "currency", unit="VND", additive="all"),
        _col("o_test", "orders", "is_test", "BOOLEAN", "dimension", "boolean"),
        _col("o_config", "orders", "config", "VARCHAR", None, "text",
             json_fields=[{"path": "is_online", "data_type": "BOOLEAN"}]),
        _col("i_order", "items", "order_id", "VARCHAR", "key", "id"),
        _col("i_line", "items", "line_no", "INTEGER", "key", "id"),
        _col("i_sku", "items", "sku", "VARCHAR", "dimension", "category"),
        _col("i_amount", "items", "line_amount", "DECIMAL", "measure", "currency"),
        _col("b_id", "branches", "branch_id", "VARCHAR", "key", "id"),
        _col("b_name", "branches", "branch_name", "VARCHAR", "dimension", "text"),
        _col("b_region", "branches", "region", "VARCHAR", "dimension", "category",
             value_catalog=region_values, value_catalog_complete=True),
        _col("c_id", "customers", "customer_id", "VARCHAR", "key", "id"),
        _col("c_name", "customers", "full_name", "VARCHAR", "dimension", "text"),
        _col("c_phone", "customers", "phone", "VARCHAR", None, "pii", pii=True),
        _col("c_segment", "customers", "segment", "VARCHAR", "dimension", "category"),
        _col("s_date", "stock", "snapshot_date", "DATE", "dimension", "date"),
        _col("s_branch", "stock", "branch_id", "VARCHAR", "key", "id"),
        _col("s_qty", "stock", "qty", "INTEGER", "measure", "count", additive="not_time"),
    ]
    # the JSON field behaves like a column with id "<column id>#<path>"
    cols.append(Column(id="o_config#is_online", entity_id="orders", physical_name="config.is_online",
                       display_name="Online order", data_type="BOOLEAN", role="dimension", semantic_type="boolean",
                       profile=ColumnProfile(), json_source="config", json_path="is_online"))
    for c in cols:
        cat.columns[c.id] = c

    def join(jid, a, b, card, pairs, jt="left", rate=None):
        return Join(id=jid, from_entity_id=a, to_entity_id=b, cardinality=card, join_type_default=jt,
                    pairs=pairs, profile=RelationshipProfile(match_rate=rate))

    cat.joins = [
        join("r1", "branches", "orders", "1:N", [("b_id", "o_branch")]),
        join("r2", "customers", "orders", "1:N", [("c_id", "o_customer")], jt="inner", rate=1.0),
        join("r3", "orders", "items", "1:N", [("o_id", "i_order")]),
        join("r4", "branches", "stock", "1:N", [("b_id", "s_branch")]),
    ]

    def metric(mid, name, eid, agg, col=None, **extra):
        return {"_id": mid, "name": name, "display_name": name, "kind": "aggregate", "entity_id": eid,
                "aggregation": agg, "column_id": col, "filters": [], "use_table_default_filters": True,
                "unit": extra.pop("unit", None), **extra}

    cat.metrics = {m["_id"]: m for m in [
        metric("m_rev", "net_revenue", "orders", "sum", "o_amount", unit="VND", synonyms=["doanh thu"]),
        metric("m_orders", "order_count", "orders", "count", unit="đơn", synonyms=["số đơn"]),
        metric("m_customers", "customer_count", "orders", "count_distinct", "o_customer", unit="khách"),
        metric("m_cancelled", "cancelled_orders", "orders", "count", unit="đơn",
               filters=[{"column_id": "o_status", "op": "=", "values": ["CANCELLED"]}],
               use_table_default_filters=False),
        metric("m_stock", "closing_stock", "stock", "sum", "s_qty", unit="cái"),
        metric("m_branches", "branch_count", "branches", "count", unit="chi nhánh"),
        {"_id": "m_aov", "name": "avg_order_value", "display_name": "AOV", "kind": "ratio",
         "numerator_metric_id": "m_rev", "denominator_metric_id": "m_orders", "ratio_scale": 1, "unit": "VND"},
    ]}
    cat.glossary = {
        "g_online": {"_id": "g_online", "term": "đơn online", "kind": "segment", "entity_id": "orders",
                     "definition": "Đơn đặt qua kênh online",
                     "filters": [{"column_id": "o_config#is_online", "op": "=", "values": ["true"]}]},
        "g_conv": {"_id": "g_conv", "term": "tăng trưởng", "kind": "definition", "definition": "% so với kỳ trước"},
    }
    return cat
