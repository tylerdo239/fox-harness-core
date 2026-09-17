"""Step 8 — Generate + validate + execute.

Builds the SQL AST per join strategy (templates.py), then reuses v1's validator and executor
untouched: validate_sql qualifies identifiers against the entity-scoped schema and blocks
PII/unexposed columns; execute_and_check runs on Dremio and returns sanity flags (empty,
fan-out ratio, all-null, implausible). No new validation logic — v1's is already stronger
than the doc's EXPLAIN-only suggestion.
"""

from dataclasses import dataclass

from sqlmodel import Session

from src.pipeline_v2.state import PipelineState
from src.pipeline_v2.templates import build_sql_ast
from src.services.dremio_client import DremioClient
from src.services.query_execution import ExecutionResult, execute_and_check
from src.services.sql_validator import ValidationResult, validate_sql


@dataclass
class GenerateResult:
    success: bool
    sql: str | None = None
    execution: ExecutionResult | None = None
    validation: ValidationResult | None = None
    error: str | None = None


def run_step8(session: Session, dremio_client: DremioClient, state: PipelineState) -> GenerateResult:
    try:
        ast = build_sql_ast(session, state)
    except Exception as e:  # noqa: BLE001 — surface any AST build failure as a step error
        return GenerateResult(success=False, error=f"sql_build_error: {e}")

    # The validation allow-list must include every table the SQL actually references. A join
    # path can route THROUGH an intermediate entity that isn't a target — e.g. counting
    # workflows per agent_model_config routes agent_model_configs -> agents -> workflows, so
    # `agents` appears in the FROM/JOIN even though it was never a selected target. Union the
    # join-plan's edge entities in, or validation rejects that intermediate table as 'not
    # allowed' and the whole cross-entity query fails.
    entity_ids = set(state.target_entity_ids)
    if state.join_plan:
        for edge in state.join_plan.edges:
            entity_ids.add(edge.from_entity_id)
            entity_ids.add(edge.to_entity_id)
    entity_ids = list(entity_ids)
    validation = validate_sql(session, ast, entity_ids)
    if not validation.is_valid:
        msg = validation.errors[0].message if validation.errors else "validation failed"
        return GenerateResult(success=False, validation=validation, error=f"validation_error: {msg}")

    grain_id = state.grain_entity_id or (entity_ids[0] if entity_ids else 0)
    execution = execute_and_check(session, dremio_client, validation.sql, grain_id)
    if not execution.success:
        return GenerateResult(
            success=False, sql=validation.sql, execution=execution, error=execution.error
        )

    return GenerateResult(success=True, sql=validation.sql, execution=execution, validation=validation)
