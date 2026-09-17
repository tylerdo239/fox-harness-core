from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class PipelineEventType(StrEnum):
    STEP_STARTED = "step_started"
    STEP_COMPLETED = "step_completed"
    RETRY = "retry"
    RESULT = "result"
    CLARIFICATION_NEEDED = "clarification_needed"
    ERROR = "error"


@dataclass
class PipelineEvent:
    type: PipelineEventType
    step: str | None = None
    message: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
