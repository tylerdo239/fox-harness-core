from src.services.pipeline_types import PipelineStep, StepFailure
from src.services.sql_validator import ValidationErrorType

MAX_ATTEMPTS = 3

# error_type -> step to restart from. Pure code, no LLM — the model never "decides" to loop.
_ROUTING_TABLE: dict[str, PipelineStep] = {
    # Step 7 validation errors
    ValidationErrorType.PARSE_ERROR: PipelineStep.GENERATE_SQL,
    ValidationErrorType.NOT_SELECT_ONLY: PipelineStep.PLAN,
    ValidationErrorType.UNKNOWN_TABLE: PipelineStep.SCHEMA_LINKING,
    ValidationErrorType.UNKNOWN_COLUMN: PipelineStep.SCHEMA_LINKING,
    ValidationErrorType.BLOCKED_COLUMN: PipelineStep.SCHEMA_LINKING,
    # Step 6 generation errors
    "sql_generation_error": PipelineStep.PLAN,
    # inner_aggregation referenced a column outside its own entity — schema_linking picked
    # the wrong entity's column, not a plan-level mistake, so retrying plan alone can't fix it
    "inner_aggregation_column_error": PipelineStep.SCHEMA_LINKING,
    # Step 4 taxonomy scope violation
    "glossary_scope_violation": PipelineStep.PLAN,
    # Step 5 join errors
    "join_path_error": PipelineStep.SCHEMA_LINKING,
    # Step 8 execution/sanity errors
    "dremio_query_error": PipelineStep.GENERATE_SQL,
    "empty_result": PipelineStep.GROUNDING,
    "likely_fanout": PipelineStep.JOIN_PATH,
}

_DEFAULT_RETRY_STEP = PipelineStep.SCHEMA_LINKING


def route_failure(failure: StepFailure) -> PipelineStep:
    """Given a failure from any step, decide which earlier step to retry from.
    Falls back to schema_linking (the earliest re-triable step) for unmapped error types."""
    return _ROUTING_TABLE.get(failure.error_type, _DEFAULT_RETRY_STEP)


def should_give_up(attempts: int) -> bool:
    return attempts >= MAX_ATTEMPTS


def build_retry_context(failures: list[StepFailure]) -> str:
    """A specific error message appended to the next attempt's prompt, so the model
    (at whichever step it restarts from) knows exactly what went wrong last time."""
    if not failures:
        return ""

    last = failures[-1]
    return (
        f"\n\nNOTE: The previous attempt failed at step '{last.step.value}' "
        f"with error '{last.error_type}': {last.message}\n"
        f"Do not repeat the same mistake."
    )
