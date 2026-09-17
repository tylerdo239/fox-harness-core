import logging
import time
from typing import Any, Awaitable, Callable

from sqlmodel import Session

from src.services.clarify import build_clarifying_question
from src.services.dremio_client import DremioClient
from src.services.embedding_client import EmbeddingClient
from src.services.grounding import ground_selection
from src.services.join_path import JoinPathError, build_join_path
from src.services.llm_client import LLMClient
from src.services.pipeline_events import PipelineEvent, PipelineEventType
from src.services.pipeline_types import PipelineStep, StepFailure, SubQuestionResult
from src.services.plan import PlanScopeError, build_plan
from src.services.repair import MAX_ATTEMPTS, build_retry_context, route_failure
from src.services.result_packaging import build_display_columns, log_query, package_result
from src.services.schema_linking import backfill_related_entities, retrieve_candidates, select_schema
from src.services.sql_generation import InnerAggregationColumnError, SQLGenerationError, generate_sql_ast
from src.services.sql_validator import validate_sql
from src.services.query_execution import execute_and_check
from src.services.taxonomy import check_scope
from src.services.vector_store import VectorStore

logger = logging.getLogger(__name__)

EventSink = Callable[[PipelineEvent], Awaitable[None]]


async def _noop_sink(event: PipelineEvent) -> None:
    return None


async def run_pipeline(
    session: Session,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    dremio_client: DremioClient,
    question: str,
    on_event: EventSink = _noop_sink,
) -> dict[str, Any]:
    """Code-driven FSM. Code always runs retrieval, always validates, always executes.
    The model only ever fills narrow, constrained slots inside individual steps.
    on_event is called at each checkpoint for progress streaming (e.g. over SSE); it is a
    no-op by default so callers that just want the final result can ignore it entirely."""
    started_at = time.monotonic()
    logger.info("pipeline start question=%r", question)

    result = await _run_full_chain(
        session, llm_client, embedding_client, vector_store, dremio_client, question, on_event
    )

    latency_ms = int((time.monotonic() - started_at) * 1000)
    logger.info(
        "pipeline done success=%s attempts=%d latency_ms=%d sql=%r",
        result.success, result.attempts, latency_ms, result.sql,
    )
    plan_json = {"attempts": result.attempts, "failures": [f.__dict__ for f in result.failures]}
    log_query(session, question, plan_json, result.sql, result, latency_ms)

    packaged = package_result(session, question, result)
    if result.success:
        await on_event(PipelineEvent(PipelineEventType.RESULT, data=packaged))
    else:
        await on_event(
            PipelineEvent(
                PipelineEventType.CLARIFICATION_NEEDED,
                message=result.clarifying_question,
                data=packaged,
            )
        )
    return packaged


async def _run_full_chain(
    session: Session,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient,
    vector_store: VectorStore,
    dremio_client: DremioClient,
    question: str,
    on_event: EventSink,
) -> SubQuestionResult:
    failures: list[StepFailure] = []
    restart_from = PipelineStep.SCHEMA_LINKING
    attempts = 0

    entity_ids: list[int] = []
    column_ids: list[int] = []
    glossary_term_ids: list[int] = []
    mandatory_glossary_ids: list[int] = []
    grounding = None
    query_plan = None
    join_plan = None

    while attempts < MAX_ATTEMPTS:
        attempts += 1
        retry_context = build_retry_context(failures)

        if attempts > 1:
            logger.warning(
                "pipeline retry attempt=%d restart_from=%s last_failure=%s",
                attempts, restart_from.value, failures[-1] if failures else None,
            )
            await on_event(
                PipelineEvent(
                    PipelineEventType.RETRY,
                    step=restart_from.value,
                    message=f"Retrying from '{restart_from.value}' (attempt {attempts}/{MAX_ATTEMPTS})",
                    data={"attempt": attempts, "restart_from": restart_from.value},
                )
            )

        try:
            if restart_from == PipelineStep.SCHEMA_LINKING:
                await on_event(PipelineEvent(PipelineEventType.STEP_STARTED, step="schema_linking"))
                retrieval = await retrieve_candidates(session, embedding_client, vector_store, question)
                selection = await select_schema(llm_client, question + retry_context, retrieval)
                selection = backfill_related_entities(session, question, selection)
                entity_ids = selection.entity_ids
                column_ids = selection.column_ids
                glossary_term_ids = selection.glossary_term_ids

                if not entity_ids:
                    failures.append(
                        StepFailure(
                            PipelineStep.SCHEMA_LINKING,
                            "no_candidates",
                            "No relevant tables were found for this question",
                        )
                    )
                    break

                logger.info(
                    "step schema_linking entity_ids=%s column_ids=%s glossary_term_ids=%s",
                    entity_ids, column_ids, glossary_term_ids,
                )
                await on_event(
                    PipelineEvent(
                        PipelineEventType.STEP_COMPLETED,
                        step="schema_linking",
                        data={"entity_ids": entity_ids, "column_ids": column_ids},
                    )
                )

            if restart_from in (PipelineStep.SCHEMA_LINKING, PipelineStep.GROUNDING):
                await on_event(PipelineEvent(PipelineEventType.STEP_STARTED, step="grounding"))
                grounding = ground_selection(
                    session, dremio_client, entity_ids, column_ids, glossary_term_ids
                )
                await on_event(PipelineEvent(PipelineEventType.STEP_COMPLETED, step="grounding"))

                await on_event(PipelineEvent(PipelineEventType.STEP_STARTED, step="taxonomy"))
                mandatory_glossary_ids = await check_scope(session, llm_client, question, glossary_term_ids)
                logger.info("step taxonomy mandatory_glossary_ids=%s", mandatory_glossary_ids)
                await on_event(
                    PipelineEvent(
                        PipelineEventType.STEP_COMPLETED,
                        step="taxonomy",
                        data={"mandatory_glossary_ids": mandatory_glossary_ids},
                    )
                )

            if restart_from in (PipelineStep.SCHEMA_LINKING, PipelineStep.GROUNDING, PipelineStep.PLAN):
                await on_event(PipelineEvent(PipelineEventType.STEP_STARTED, step="plan"))
                query_plan = await build_plan(
                    session, llm_client, embedding_client, vector_store, question + retry_context, grounding,
                    mandatory_glossary_ids=mandatory_glossary_ids,
                )
                logger.info(
                    "step plan filters=%s group_by=%s agg=%s/%s order_by_col=%s order_by_agg=%s limit=%s assumptions=%s",
                    query_plan.filters, query_plan.group_by_columns, query_plan.aggregation_column_id,
                    query_plan.aggregation_function, query_plan.order_by_column_id,
                    query_plan.order_by_aggregation, query_plan.limit, query_plan.assumptions,
                )
                await on_event(
                    PipelineEvent(
                        PipelineEventType.STEP_COMPLETED,
                        step="plan",
                        data={"assumptions": query_plan.assumptions},
                    )
                )

            if restart_from != PipelineStep.EXECUTE or join_plan is None:
                await on_event(PipelineEvent(PipelineEventType.STEP_STARTED, step="join_path"))
                join_plan = build_join_path(session, entity_ids)
                await on_event(PipelineEvent(PipelineEventType.STEP_COMPLETED, step="join_path"))

            await on_event(PipelineEvent(PipelineEventType.STEP_STARTED, step="generate_sql"))
            sql_ast = generate_sql_ast(session, join_plan, query_plan)
            validation = validate_sql(session, sql_ast, entity_ids)

            if not validation.is_valid:
                error = validation.errors[0]
                failure = StepFailure(PipelineStep.VALIDATE, error.error_type.value, error.message)
                failures.append(failure)
                logger.warning("step generate_sql validation failed: %s", error.message)
                await on_event(
                    PipelineEvent(
                        PipelineEventType.ERROR,
                        step="validate",
                        message=error.message,
                        data={"error_type": error.error_type.value},
                    )
                )
                restart_from = route_failure(failure)
                continue

            logger.info("step generate_sql sql=%r", validation.sql)
            await on_event(
                PipelineEvent(PipelineEventType.STEP_COMPLETED, step="generate_sql", data={"sql": validation.sql})
            )

            await on_event(PipelineEvent(PipelineEventType.STEP_STARTED, step="execute"))
            base_entity_id = query_plan.entity_ids[0] if query_plan.entity_ids else entity_ids[0]
            exec_result = execute_and_check(session, dremio_client, validation.sql, base_entity_id)

            if not exec_result.success:
                failure = StepFailure(PipelineStep.EXECUTE, "dremio_query_error", exec_result.error or "")
                failures.append(failure)
                logger.warning("step execute dremio error: %s", exec_result.error)
                await on_event(
                    PipelineEvent(PipelineEventType.ERROR, step="execute", message=exec_result.error)
                )
                restart_from = route_failure(failure)
                continue

            blocking_flags = [f for f in exec_result.sanity_flags if f.flag_type.value == "likely_fanout"]
            if blocking_flags and attempts < MAX_ATTEMPTS:
                failure = StepFailure(PipelineStep.EXECUTE, blocking_flags[0].flag_type.value, blocking_flags[0].message)
                failures.append(failure)
                logger.warning("step execute sanity flag: %s", blocking_flags[0].message)
                await on_event(
                    PipelineEvent(PipelineEventType.ERROR, step="execute", message=blocking_flags[0].message)
                )
                restart_from = route_failure(failure)
                continue

            logger.info("step execute row_count=%d", exec_result.row_count)
            await on_event(
                PipelineEvent(
                    PipelineEventType.STEP_COMPLETED,
                    step="execute",
                    data={"row_count": exec_result.row_count},
                )
            )

            display_columns = build_display_columns(session, query_plan.output_columns)
            return SubQuestionResult(
                question=question,
                success=True,
                sql=validation.sql,
                rows=exec_result.rows,
                row_count=exec_result.row_count,
                display_columns=display_columns,
                assumptions=query_plan.assumptions,
                sanity_warnings=[f.message for f in exec_result.sanity_flags],
                attempts=attempts,
                failures=failures,
            )

        except (JoinPathError, SQLGenerationError, PlanScopeError) as err:
            if isinstance(err, JoinPathError):
                error_type, step = "join_path_error", PipelineStep.JOIN_PATH
            elif isinstance(err, InnerAggregationColumnError):
                error_type, step = "inner_aggregation_column_error", PipelineStep.PLAN
            elif isinstance(err, SQLGenerationError):
                error_type, step = "sql_generation_error", PipelineStep.GENERATE_SQL
            else:
                error_type, step = "glossary_scope_violation", PipelineStep.PLAN
            failure = StepFailure(step, error_type, str(err))
            failures.append(failure)
            logger.warning("step %s raised %s: %s", step.value, error_type, err)
            await on_event(PipelineEvent(PipelineEventType.ERROR, step=step.value, message=str(err)))
            restart_from = route_failure(failure)
            continue

    clarifying_question = build_clarifying_question(question, failures)
    return SubQuestionResult(
        question=question,
        success=False,
        assumptions=query_plan.assumptions if query_plan else [],
        attempts=attempts,
        failures=failures,
        clarifying_question=clarifying_question,
    )
