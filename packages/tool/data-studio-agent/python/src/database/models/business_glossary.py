from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


class BusinessGlossaryTerm(SQLModel, table=True):
    __tablename__ = "business_glossary"

    id: int | None = Field(default=None, primary_key=True)

    term: str = Field(index=True)
    synonyms: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    definition_text: str
    # multiple WHERE predicates, AND-combined when the term is applied. A term can carry several
    # conditions (e.g. a JSON-flag check plus a node_type constraint) instead of one string.
    sql_expressions: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    related_entity_ids: list[int] = Field(default_factory=list, sa_column=Column(JSON))
