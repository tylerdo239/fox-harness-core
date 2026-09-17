import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { DataStudioKernel } from './kernel.ts'

export const name = 'fox-harness-tool-data-studio-agent'
export const inject = ['tools']

// pipeline_v3 (packages/tool/data-studio-agent/python) runs a 12-step multi-agent
// SQL pipeline (many sequential LLM calls: retrieval, worker/parser x2, compile
// fix_hint loop, insight, chart selection) plus up to ~36s of chart vision-review
// timeouts per chart (no frontend attached to answer those — see bridge/runner.py's
// module docstring). Originally set to 240_000 based on the docstring's "1-2+
// minutes" estimate; a real measured end-to-end run against this deployment's
// actual model/proxy (a single plain COUNT(*) question, one chart) took 432s —
// almost double that estimate — and was silently killed by this timeout with
// `kernel.ts` correctly reporting "ran longer than N seconds" (not a hang, just
// too short a budget). Raised with real margin above the measured worst case.
const TIMEOUT_MS = 600_000

export function apply(ctx: Context) {
  const kernel = new DataStudioKernel()
  ctx.effect(() => () => kernel.stop(), 'fox-harness-tool-data-studio-agent.kernel')

  ctx.tools.register(
    defineTool({
      name: 'analyze_data',
      description: [
        "Answer a question about the company's real business data (revenue, customers, orders, ",
        'metrics, etc.) by querying the data warehouse through a dedicated multi-step SQL analysis ',
        'agent. Use this for questions that need real business data — not general knowledge, and not ',
        "arbitrary file/data-science analysis (use the `python` tool for that instead). Returns a ",
        'natural-language answer plus the SQL used, a result table, and a chart when one applies. ',
        // Real bug found the hard way (2026-09-17 live test): a question like
        // "which agent handles the most workflows" was answered with
        // `list_agents`/`job_list` instead — the model read "agent" as THIS
        // harness's own subagent/background-job concept and never called this
        // tool at all. In the company's own data, "agent" is a normal business
        // row (e.g. a virtual/support staff record in an `agents` table) with
        // no relation to fox-harness's subagents or background jobs.
        'IMPORTANT: if the question mentions "agent"/"agents" alongside a business word (workflow, ',
        'customer, ticket, conversation, revenue, etc.), that means a business entity in the company\'s ',
        "own data — call THIS tool. It has nothing to do with fox-harness's own subagents or background ",
        'jobs (`list_agents`/`job_list`); do not answer such a question from those. ',
        'Slow — often several minutes (it runs a multi-step pipeline: retrieval, SQL generation, ',
        'execution, chart generation), regardless of how simple the question looks. Ask one clear, ',
        'complete question per call and then wait; a timeout is not caused by question complexity, so ',
        "retrying with a \"simpler\" version of the same question will not be faster — only retry if the ",
        'question itself was actually ambiguous or wrong.',
      ].join(''),
      parameters: {
        question: {
          type: 'string',
          required: true,
          description: 'The business question in natural language, self-contained (no "it"/"that" referring to earlier turns).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answer: { type: 'string', required: true },
            sql: { type: 'string' },
            columns: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'json' } },
            row_count: { type: 'integer' },
            chart: { type: 'json' },
            chart_id: { type: 'integer' },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.answer }],
        presentationMeta: (_args, value) => ({
          sql: value.sql ?? null,
          columns: value.columns ?? [],
          rows: value.rows ?? [],
          rowCount: value.row_count ?? 0,
          chart: value.chart ?? null,
          // docs/data-studio-admin-ui-plan.md phase 5 — lets DataStudioResultPill
          // offer "pin to dashboard" (the real Chart row this references
          // already exists — see bridge/runner.py's `_persist_chart`).
          chartId: value.chart_id ?? null,
          truncated: value.truncated,
        }),
      },
      async execute(args, exec) {
        const reply = await kernel.ask(args.question, TIMEOUT_MS, exec.signal)
        if (!reply.ok) throw new Error(reply.error ?? 'analyze_data: unknown error')
        return {
          answer: reply.answer ?? '',
          truncated: reply.truncated ?? false,
          columns: reply.columns ?? [],
          rows: reply.rows ?? [],
          row_count: reply.row_count ?? 0,
          ...(reply.sql ? { sql: reply.sql } : {}),
          ...(reply.chart ? { chart: reply.chart } : {}),
          ...(reply.chart_id ? { chart_id: reply.chart_id } : {}),
        }
      },
    }),
  )
}
