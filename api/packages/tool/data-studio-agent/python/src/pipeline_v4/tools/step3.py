"""Edit toolkits of step 3 (find the profile): table picker, term matcher, value matcher."""

from typing import Any, ClassVar

from src.pipeline_v4.agents.base import Draft
from src.pipeline_v4.agents.parts import TablesOut, TermsOut, ValuesOut
from src.pipeline_v4.agents.retrieval import PickedTable, PickedValue
from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.context import Names
from src.pipeline_v4.tools.common import (
    Scalar,
    as_text,
    canonical,
    not_in_question,
    same,
    value_problem,
)
from src.pipeline_v4.tools.drafts import DraftToolkit


class TableTools(DraftToolkit):
    parts: ClassVar = {"tables": lambda x: x.table}

    def __init__(self, draft: Draft[TablesOut], names: Names, **kwargs: Any) -> None:
        self.h = names
        super().__init__("table_tools", draft, [self.add_table], **kwargs)

    async def add_table(self, table: str, reason: str) -> str:
        """Add a table the question is about.

        Args:
            table: table name, as listed.
            reason: e.g. "one row = one <A>, counted".
        """
        name, problem = canonical(self.h, table, "table")
        if name is None:
            return self.error(problem)
        if any(same(t.table, name) for t in self.draft.value.tables):
            return self.duplicate(name)
        self.draft.value.tables.append(PickedTable(table=name, reason=reason))
        return self.ok(f"table {name}")


class TermTools(DraftToolkit):
    parts: ClassVar = {"terms": str}

    def __init__(self, draft: Draft[TermsOut], names: Names, **kwargs: Any) -> None:
        self.h = names
        super().__init__("term_tools", draft, [self.add_term], **kwargs)

    async def add_term(self, term: str) -> str:
        """Add a business term the question uses.

        Args:
            term: the term's name exactly as search_term or the context lists it (in quotes).
        """
        name, problem = canonical(self.h, term, "term")
        if name is None:
            return self.error(problem)
        if name in self.draft.value.terms:
            return self.duplicate(name)
        self.draft.value.terms.append(name)
        return self.ok(f"term {name}")


class ValueTools(DraftToolkit):
    parts: ClassVar = {"values": lambda x: x.phrase}
    phrased: ClassVar = True

    def __init__(self, draft: Draft[ValuesOut], names: Names, cat: Catalog, **kwargs: Any) -> None:
        self.h, self.cat = names, cat
        super().__init__("value_tools", draft, [self.add_value], **kwargs)

    async def add_value(self, phrase: str, column: str, value: Scalar) -> str:
        """Record the stored code of a value the question names.

        Args:
            phrase: the words of the question that name the value.
            column: table.column.
            value: the stored code (see list_values), not its label.
        """
        if (problem := not_in_question(self.draft, phrase)):
            return self.error(problem)
        name, problem = canonical(self.h, column, "column")
        if name is None:
            return self.error(problem)
        text = as_text(value)
        if (problem := value_problem(self.cat, self.h, name, [text])):
            return self.error(problem)
        self.draft.value.values.append(PickedValue(phrase=phrase, column=name, value=text))
        return self.ok(f"{phrase} → {name} = {text}")
