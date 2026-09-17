"""Persisted chat history: conversations → messages → query_results → charts.

A message is one turn. A user message just carries text; an assistant message carries the
answer_markdown plus one-or-more query_results (one per SQL executed — a simple answer has one,
a decomposed answer has one per sub-question). Each query_result snapshots its rows as JSON so a
saved chart/report is reproducible even if the underlying data later changes. Each query_result
has one-or-more charts (the chart specs), and any chart can be pinned (`is_pinned`) to be picked
into a report or dashboard later.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, Relationship, SQLModel

from src.database.models.enums import MessageRole


class Conversation(SQLModel, table=True):
    __tablename__ = "conversations_chat"

    id: int | None = Field(default=None, primary_key=True)
    title: str | None = None  # derived from the first question, editable later
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    messages: list["Message"] = Relationship(
        back_populates="conversation",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "Message.seq"},
    )


class Message(SQLModel, table=True):
    __tablename__ = "messages_chat"

    id: int | None = Field(default=None, primary_key=True)
    conversation_id: int = Field(foreign_key="conversations_chat.id", index=True)
    seq: int = Field(default=0)  # ordering within the conversation
    role: MessageRole

    # user turn: the raw question; assistant turn: the streamed markdown answer
    content: str = ""
    question: str | None = None          # the original user question this answer responds to
    answer_markdown: str | None = None    # combined/streamed markdown (assistant)
    is_decomposed: bool = Field(default=False)
    # suggested follow-up questions produced by enrichment (assistant turn)
    follow_up_questions_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    conversation: Conversation | None = Relationship(back_populates="messages")
    query_results: list["QueryResult"] = Relationship(
        back_populates="message",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "QueryResult.seq"},
    )


class QueryResult(SQLModel, table=True):
    __tablename__ = "query_results_chat"

    id: int | None = Field(default=None, primary_key=True)
    message_id: int = Field(foreign_key="messages_chat.id", index=True)
    seq: int = Field(default=0)

    # for a decomposed answer, which sub-question this result came from
    sub_id: str | None = None
    sub_question: str | None = None

    sql: str | None = None
    row_count: int = 0
    # snapshot of the actual rows + display metadata at answer time (reproducible reports)
    rows_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    display_columns_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))

    message: Message | None = Relationship(back_populates="query_results")
    charts: list["Chart"] = Relationship(
        back_populates="query_result",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class Chart(SQLModel, table=True):
    __tablename__ = "charts_chat"

    id: int | None = Field(default=None, primary_key=True)
    query_result_id: int = Field(foreign_key="query_results_chat.id", index=True)

    type: str  # line | bar | scatter | pie | table
    title: str = ""
    description: str = ""
    x: str | None = None
    y_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    value_field: str | None = None
    recommended: bool = Field(default=False)
    # this chart's OWN data (from a per-chart transform, e.g. a pie's pct column). Empty = the chart
    # uses the shared query-result rows. Saved so a reload renders EXACTLY what streaming showed.
    rows_json: list[dict] = Field(default_factory=list, sa_column=Column(JSON))
    transform_code: str = ""

    # user edits from the chart toolbar (Edit fields / Edit colors), persisted so they survive a
    # reload. None/empty = no override, fall back to the recommended x/y and the default palette.
    title_override: str | None = None
    x_override: str | None = None
    y_override_json: list[str] | None = Field(default=None, sa_column=Column(JSON))
    color_overrides_json: dict[str, str] = Field(default_factory=dict, sa_column=Column(JSON))
    # per-field display-label overrides (physical_name → custom label, e.g. name → "workflow name")
    label_overrides_json: dict[str, str] = Field(default_factory=dict, sa_column=Column(JSON))

    # picked into a report/dashboard by the user
    is_pinned: bool = Field(default=False)

    query_result: QueryResult | None = Relationship(back_populates="charts")
