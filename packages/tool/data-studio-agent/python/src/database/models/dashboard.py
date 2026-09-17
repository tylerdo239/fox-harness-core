"""Dashboards: a saved collection of charts (pinned from chat) laid out on a grid.

A Dashboard groups widgets. A widget is usually a CHART pinned from a conversation (it
references the saved Chart row, reusing its snapshotted rows), but the schema also carries the
layout + kind needed by the drag/resize builder that comes later (text / kpi / divider / filter
widgets, x/y/w/h on a 12-column grid). For this pass only chart widgets are created.

`appearance_json` holds the builder's theme choices (theme, cardStyle, header variant, density) so
the view + the PDF render match. Charts are referenced by id — deleting the source conversation
would orphan the widget, so the widget snapshots the chart's title/data at pin time is NOT done;
instead we resolve the live Chart on read and skip widgets whose chart vanished.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, Relationship, SQLModel


class Dashboard(SQLModel, table=True):
    __tablename__ = "dashboards_chat"

    id: int | None = Field(default=None, primary_key=True)
    title: str = "Dashboard chưa đặt tên"
    description: str = ""
    # theme / cardStyle / header / density — the builder's appearance controls
    appearance_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    widgets: list["DashboardWidget"] = Relationship(
        back_populates="dashboard",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "DashboardWidget.seq"},
    )


class DashboardWidget(SQLModel, table=True):
    __tablename__ = "dashboard_widgets_chat"

    id: int | None = Field(default=None, primary_key=True)
    dashboard_id: int = Field(foreign_key="dashboards_chat.id", index=True)
    seq: int = Field(default=0)  # order + default stacking

    kind: str = "chart"  # chart | text | kpi | divider | filter
    # for kind=chart: the pinned Chart row (its rows/spec are resolved on read)
    chart_id: int | None = Field(default=None, foreign_key="charts_chat.id")

    # 12-column grid placement (builder). Sensible defaults so a freshly-pinned chart lays out.
    x: int = 0
    y: int = 0
    w: int = 6
    h: int = 4

    # per-widget overrides / non-chart content (builder)
    title_override: str | None = None
    note: str | None = None
    text: str | None = None
    config_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))

    dashboard: Dashboard | None = Relationship(back_populates="widgets")
