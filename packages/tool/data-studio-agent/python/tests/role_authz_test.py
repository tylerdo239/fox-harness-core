"""Role-based data access (src/security/role.py) against a REAL MongoDB in a throw-away database.

Checks the two places the analyze_data pipeline is gated for role `user` (Dremio OSS has no policies, so
these ARE the boundary): what the catalog readers return, and what `validate_sql` lets through to Dremio.

    cd packages/tool/data-studio-agent/python && MONGODB_URL=mongodb://127.0.0.1:27017 uv run python tests/role_authz_test.py
"""

import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("MONGODB_URL", "mongodb://127.0.0.1:27017")

import sqlglot  # noqa: E402
from sqlglot import exp  # noqa: E402

from src.crud_mongo import business_glossary as glossary_crud  # noqa: E402
from src.crud_mongo import entity as entity_crud  # noqa: E402
from src.crud_mongo import entity_column as column_crud  # noqa: E402
from src.crud_mongo import metric as metric_crud  # noqa: E402
from src.crud_mongo import relationship as relationship_crud  # noqa: E402
from src.database.mongodb import AttrDatabase, mongo_client  # noqa: E402
from src.security import role  # noqa: E402
from src.services.sql_validator import validate_sql  # noqa: E402

DB_NAME = f"fox_role_authz_{uuid.uuid4().hex[:8]}"
raw = mongo_client[DB_NAME]
db = AttrDatabase(raw)

failures = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global failures
    print(("ok    " if condition else "FAIL  ") + label + (f"  -> {detail}" if detail and not condition else ""))
    if not condition:
        failures += 1


def entity(_id, name, allowed, pii=False):
    raw.entities.insert_one({"_id": _id, "data_source_id": "ds", "physical_path": f"cat.db.{name}", "physical_name": name,
                             "is_exposed": True, "is_deprecated": False, "is_pii": pii, "allowed_roles": allowed})


def column(_id, entity_id, name, allowed, pii=False, exposed=True):
    raw.entity_columns.insert_one({"_id": _id, "entity_id": entity_id, "physical_name": name, "data_type": "VARCHAR",
                                   "ordinal": 1, "is_exposed": exposed, "is_deprecated": False, "is_pii": pii, "allowed_roles": allowed})


def sql_ok(sql: str, entity_ids: list[str]) -> tuple[bool, str]:
    result = validate_sql(db, sqlglot.parse_one(sql), entity_ids)
    return result.is_valid, (result.errors[0].message if result.errors else "")


try:
    # pub: a table opted in for users. secret: admin-only. legacy: no allowed_roles at all (data from before
    # this change -> admin-only). pii_tbl: opted in but flagged PII as a whole.
    entity("pub", "workflows", ["admin", "user"])
    entity("secret", "salaries", ["admin"])
    entity("legacy", "legacy_tbl", None)
    entity("pii_tbl", "people", ["admin", "user"], pii=True)
    column("pub_id", "pub", "id", ["admin", "user"])
    column("pub_name", "pub", "name", ["admin", "user"])
    column("pub_ssn", "pub", "ssn", ["admin", "user"], pii=True)
    column("pub_cost", "pub", "cost", ["admin"])
    column("sec_amount", "secret", "amount", ["admin", "user"])  # opted in, but its TABLE is admin-only
    raw.relationships.insert_one({"_id": "rel", "from_entity_id": "pub", "to_entity_id": "secret"})
    raw.metrics.insert_one({"_id": "m_ok", "base_entity_id": "pub", "measure_column_id": "pub_id", "allowed_dimension_column_ids": ["pub_name", "pub_cost"]})
    raw.metrics.insert_one({"_id": "m_bad", "base_entity_id": "pub", "measure_column_id": "pub_cost"})
    raw.business_glossary.insert_one({"_id": "g_ok", "term": "flow", "related_entity_ids": ["pub"]})
    raw.business_glossary.insert_one({"_id": "g_bad", "term": "pay", "related_entity_ids": ["pub", "secret"]})
    ALL = ["pub", "secret", "legacy", "pii_tbl"]

    print("--- catalog readers, role user")
    role.set_role("user")
    check("user sees only the opted-in, non-PII table", {e.id for e in entity_crud.list_exposed_active(db)} == {"pub"}, str([e.id for e in entity_crud.list_exposed_active(db)]))
    check("user cannot fetch an admin-only table by id", entity_crud.get_by_id(db, "secret") is None)
    check("user cannot fetch a legacy table (no allowed_roles = admin-only)", entity_crud.get_by_id(db, "legacy") is None)
    check("user cannot fetch a PII table", entity_crud.get_by_id(db, "pii_tbl") is None)
    check("user sees only opted-in, non-PII columns", {c.physical_name for c in column_crud.list_exposed_by_entity(db, "pub")} == {"id", "name"})
    check("an opted-in column of an admin-only table stays hidden", column_crud.get_by_id(db, "sec_amount") is None)
    check("column lookup by name honours the role", column_crud.get_by_entity_and_name(db, "pub", "cost") is None)
    metrics = {m.id: m for m in metric_crud.list_all(db)}
    check("metric over a hidden measure column is hidden", set(metrics) == {"m_ok"}, str(set(metrics)))
    check("hidden dimension columns are stripped from a visible metric", metrics.get("m_ok", {}).get("allowed_dimension_column_ids") == ["pub_name"])
    check("glossary term touching a hidden table is hidden", {g.id for g in glossary_crud.list_all(db)} == {"g_ok"})
    check("relationship into a hidden table is hidden", relationship_crud.list_all(db) == [])

    print("--- catalog readers, role admin")
    with role.as_role("admin"):
        check("admin sees every exposed table", {e.id for e in entity_crud.list_exposed_active(db)} == set(ALL))
        check("admin sees every exposed column", {c.physical_name for c in column_crud.list_exposed_by_entity(db, "pub")} == {"id", "name", "ssn", "cost"})
        check("admin sees every metric/glossary/relationship", len(metric_crud.list_all(db)) == 2 and len(glossary_crud.list_all(db)) == 2 and len(relationship_crud.list_all(db)) == 1)

    print("--- validate_sql, role user (the gate in front of Dremio)")
    role.set_role("user")
    cases = [
        ("allowed columns", "SELECT t.name, COUNT(t.id) FROM cat.db.workflows AS t GROUP BY t.name", True),
        ("admin-only table", "SELECT s.amount FROM cat.db.salaries AS s", False),
        ("legacy table (no flag)", "SELECT 1 AS x FROM cat.db.legacy_tbl", False),
        ("admin-only column", "SELECT cost FROM cat.db.workflows", False),
        ("admin-only column behind an ALIAS", "SELECT t.cost FROM cat.db.workflows AS t", False),
        ("PII column behind an alias", "SELECT w.ssn FROM cat.db.workflows AS w", False),
        ("SELECT * (expands to forbidden columns)", "SELECT * FROM cat.db.workflows", False),
        ("forbidden column used only in WHERE", "SELECT t.name FROM cat.db.workflows AS t WHERE t.cost > 10", False),
        ("join into an admin-only table", "SELECT t.name FROM cat.db.workflows AS t JOIN cat.db.salaries AS s ON t.id = s.amount", False),
    ]
    for label, sql, want in cases:
        ok, why = sql_ok(sql, ALL)
        check(f"{'allows' if want else 'refuses'}: {label}", ok == want, why or "accepted")

    # A raw fragment (how glossary filters are embedded) naming a forbidden column must be refused.
    tree = sqlglot.parse_one("SELECT t.name FROM cat.db.workflows AS t")
    tree = tree.where(exp.Var(this='"t"."cost" > 100'))
    result = validate_sql(db, tree, ALL)
    check("refuses: raw expression fragment naming a forbidden column", not result.is_valid, "accepted")

    print("--- validate_sql, role admin (behaviour unchanged)")
    with role.as_role("admin"):
        for label, sql, want in [
            ("admin-only column", "SELECT t.cost FROM cat.db.workflows AS t", True),
            ("admin-only table", "SELECT s.amount FROM cat.db.salaries AS s", True),
            ("PII column still refused for admin (unchanged rule)", "SELECT t.ssn FROM cat.db.workflows AS t", False),
        ]:
            ok, why = sql_ok(sql, ALL)
            check(f"admin {'allows' if want else 'refuses'}: {label}", ok == want, why or "accepted")
finally:
    mongo_client.drop_database(DB_NAME)

print("\nALL ROLE CHECKS PASSED" if failures == 0 else f"\n{failures} FAILED")
sys.exit(1 if failures else 0)
