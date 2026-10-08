"""Ours (2026-10-08): keep chart titles in the question's language. The chart agents are told to, but with a
Vietnamese semantic layer around them the local model still titled English questions in Vietnamese."""

import re

# letters only Vietnamese uses (plain a-z, digits and punctuation say nothing)
_VI = re.compile(r"[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịĩọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹàáèéìíòóùúýõã]", re.IGNORECASE)


def is_vietnamese(text: str | None) -> bool:
    return bool(text and _VI.search(text))


def title_for(title: str | None, question: str) -> str:
    """The chart's title, or the question itself when the title came out in Vietnamese for a question that is not."""
    if not title:
        return question
    if is_vietnamese(title) and not is_vietnamese(question):
        return question
    return title


def table_title(question: str) -> str:
    return "Bảng dữ liệu" if is_vietnamese(question) else "Data table"
