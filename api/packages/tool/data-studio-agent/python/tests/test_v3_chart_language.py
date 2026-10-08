"""Ours: chart titles follow the question's language (pipeline_v3/lang.py)."""

from src.pipeline_v3.lang import is_vietnamese, table_title, title_for


def test_detects_vietnamese() -> None:
    assert is_vietnamese("Số lượng workflow theo trạng thái")
    assert not is_vietnamese("How many workflows are there by status?")


def test_vietnamese_title_for_an_english_question_falls_back_to_the_question() -> None:
    q = "How many workflows are there by status?"
    assert title_for("Số lượng workflow theo trạng thái", q) == q
    assert title_for("Workflows by status", q) == "Workflows by status"
    assert title_for(None, q) == q


def test_vietnamese_question_keeps_its_vietnamese_title() -> None:
    assert title_for("Số lượng workflow", "Có bao nhiêu workflow?") == "Số lượng workflow"


def test_table_title() -> None:
    assert table_title("Có bao nhiêu workflow?") == "Bảng dữ liệu"
    assert table_title("How many workflows?") == "Data table"
