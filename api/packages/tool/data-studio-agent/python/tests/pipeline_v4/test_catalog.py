"""load_catalog leaves out what is turned off in the profile (disabled_at), and what is built on it."""

import asyncio
from datetime import UTC, datetime
from typing import Any

from src.pipeline_v4.catalog import load_catalog

OFF = datetime(2026, 9, 1, tzinfo=UTC)


def _match(doc: dict[str, Any], q: dict[str, Any]) -> bool:
    for k, v in q.items():
        have = doc.get(k)
        if isinstance(v, dict) and "$in" in v:
            if have not in v["$in"]:
                return False
        elif have != v:   # None also matches a missing field, as in Mongo
            return False
    return True


class Cursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        return list(self.docs)


class Collection:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def find(self, q: dict[str, Any], projection: Any = None) -> Cursor:
        return Cursor([d for d in self.docs if _match(d, q)])


def _table(tid: str, source: str) -> dict[str, Any]:
    return {"_id": tid, "data_source_id": source, "physical_path": f"s.{tid}", "physical_name": tid,
            "is_deprecated": False, "is_exposed": True}


def _db() -> dict[str, Collection]:
    return {
        "data_sources": Collection([{"_id": "on", "deleted_at": None}, {"_id": "off", "deleted_at": None,
                                                                         "disabled_at": OFF}]),
        "entities": Collection([_table("t1", "on"), _table("t2", "off")]),
        "entity_columns": Collection([]),
        "relationships": Collection([]),
        "relationship_column_pairs": Collection([]),
        "profile_metrics": Collection([
            {"_id": "m1", "name": "a", "kind": "aggregate", "entity_id": "t1", "deleted_at": None},
            {"_id": "m2", "name": "b", "kind": "aggregate", "entity_id": "t1", "deleted_at": None, "disabled_at": OFF},
            {"_id": "r1", "name": "a_per_b", "kind": "ratio", "numerator_metric_id": "m1",
             "denominator_metric_id": "m2", "deleted_at": None}]),
        "profile_glossary": Collection([
            {"_id": "g1", "term": "x", "kind": "definition", "deleted_at": None},
            {"_id": "g2", "term": "y", "kind": "definition", "deleted_at": None, "disabled_at": OFF},
            {"_id": "g3", "term": "z", "kind": "metric", "metric_id": "m2", "deleted_at": None}]),
    }


def test_disabled_items_and_what_is_built_on_them_are_left_out() -> None:
    from src.data_profile.glossary import COLLECTION as GLOSSARY
    from src.data_profile.metrics import COLLECTION as METRICS

    db = _db()
    db[METRICS] = db.pop("profile_metrics")
    db[GLOSSARY] = db.pop("profile_glossary")
    cat = asyncio.run(load_catalog(db))  # type: ignore[arg-type]
    assert set(cat.tables) == {"t1"}                                    # the disabled source's table is gone
    assert {k for k in cat.metrics if not k.startswith("builtin:")} == {"m1"}  # m2 off, its ratio r1 with it
    assert set(cat.glossary) == {"g1"}                                  # g2 off, g3 is a term on m2
