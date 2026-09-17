from src.services.pipeline_types import StepFailure
from src.services.sql_validator import ValidationErrorType

_CLARIFICATION_TEMPLATES: dict[str, str] = {
    ValidationErrorType.UNKNOWN_COLUMN: (
        "I couldn't find a column matching part of your question. Could you rephrase which "
        "field you mean, or point me to the specific table/column?"
    ),
    ValidationErrorType.UNKNOWN_TABLE: (
        "I couldn't confidently identify which data table your question refers to. "
        "Could you name the table or describe the data more specifically?"
    ),
    ValidationErrorType.BLOCKED_COLUMN: (
        "The data needed to answer this is marked as restricted/PII and I can't query it. "
        "Is there a related, non-restricted field that would work instead?"
    ),
    "empty_result": (
        "I ran a query but got no matching data. Could you double-check the filter values "
        "you're looking for (e.g. exact spelling, date range) or confirm they're correct?"
    ),
    "likely_fanout": (
        "Answering this required joining tables in a way that risks double-counting. "
        "Could you clarify exactly what you want counted (e.g. per-record vs per-group)?"
    ),
}

_DEFAULT_CLARIFICATION = (
    "I wasn't able to confidently answer this after a few attempts. Could you rephrase "
    "the question or provide more specific details (exact names, date ranges, or values)?"
)


def build_clarifying_question(question: str, failures: list[StepFailure]) -> str:
    """Never emit a guessed number. Code-only — builds a clarifying question from the exact
    sticking point of the last failure, so the user knows what specifically to clarify."""
    if not failures:
        return _DEFAULT_CLARIFICATION

    last = failures[-1]
    template = _CLARIFICATION_TEMPLATES.get(last.error_type, _DEFAULT_CLARIFICATION)
    return f"{template}\n\n(Question: \"{question}\")"
