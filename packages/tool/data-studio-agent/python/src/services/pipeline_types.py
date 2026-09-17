from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class PipelineStep(StrEnum):
    SCHEMA_LINKING = "schema_linking"
    GROUNDING = "grounding"
    PLAN = "plan"
    JOIN_PATH = "join_path"
    GENERATE_SQL = "generate_sql"
    VALIDATE = "validate"
    EXECUTE = "execute"


@dataclass
class StepFailure:
    step: PipelineStep
    error_type: str
    message: str


@dataclass
class SubQuestionResult:
    question: str
    success: bool
    sql: str | None = None
    rows: list[dict[str, Any]] = field(default_factory=list)
    row_count: int = 0
    display_columns: list[dict[str, Any]] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    sanity_warnings: list[str] = field(default_factory=list)
    attempts: int = 0
    failures: list[StepFailure] = field(default_factory=list)
    clarifying_question: str | None = None
