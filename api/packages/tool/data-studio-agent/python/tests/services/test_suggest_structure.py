"""AI suggestions for a table's structure fields: answers are limited to the allowed options and the
table's own columns, and column names come back as ids."""

from src.data_profile.suggest import _structure_answer, _structure_schema

BY_NAME = {"order_id": "c1", "order_line": "c2", "customer_name": "c3"}


def test_grain_keys_come_back_as_column_ids_and_unknown_names_are_dropped() -> None:
    got = _structure_answer("grain_keys", {"key": "order_id", "second_key": "order_line", "confidence": "high"}, BY_NAME)
    assert got is not None and got.column_ids == ["c1", "c2"] and got.confidence == "high"
    one = _structure_answer("grain_keys", {"key": "order_id", "second_key": "", "confidence": "high"}, BY_NAME)
    assert one is not None and one.column_ids == ["c1"]
    assert _structure_answer("grain_keys", {"key": "nope", "second_key": "", "confidence": "high"}, BY_NAME) is None


def test_label_column_may_be_none_and_kinds_must_be_allowed_values() -> None:
    assert _structure_answer("label_column", {"value": "customer_name", "confidence": "medium"}, BY_NAME).value == "c3"  # type: ignore[union-attr]
    assert _structure_answer("label_column", {"value": "", "confidence": "low"}, BY_NAME).value == ""  # type: ignore[union-attr]
    assert _structure_answer("table_kind", {"value": "dim", "confidence": "high"}, BY_NAME).value == "dim"  # type: ignore[union-attr]
    assert _structure_answer("trust", {"value": "gold", "confidence": "high"}, BY_NAME) is None


def test_the_schema_offers_only_the_tables_columns() -> None:
    schema = _structure_schema("grain_keys", list(BY_NAME))
    assert schema["properties"]["key"]["enum"] == list(BY_NAME) and schema["properties"]["second_key"]["enum"][-1] == ""
    assert _structure_schema("label_column", list(BY_NAME))["properties"]["value"]["enum"][-1] == ""
