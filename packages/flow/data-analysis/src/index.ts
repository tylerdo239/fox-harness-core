import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'

export const name = 'fox-harness-flow-data-analysis'

/**
 * Scaffold for docs/data-analysis-flow-plan.md — a companion plugin, NOT a
 * competing agent loop. Hooks the SAME default `@fox-harness/dsh-agent-driver`
 * loop's event taxonomy (see that package's src/agent.ts: it dispatches
 * `agent/pre-step` as a waterfall through `agentEvents(ctx, this)`, exactly
 * like upstream `@deepseek-ai/dsh-agent-loop` does — confirmed against
 * node_modules/@deepseek-ai/dsh-agent-loop/README.md's own "What belongs to
 * plugins" section and node_modules/@deepseek-ai/dsh-repeat-tool-reminder's
 * real `ctx.on('agent/pre-step', (payload, next) => ...)` usage, which this
 * mirrors).
 *
 * This bundle is listed ONLY in
 * @fox-harness/profile-template-data-analysis's `bundles` (never the default
 * profile's) — services/orchestrator/src/materialize.ts materializes a
 * different profile dir per flow (docs/data-analysis-flow-plan.md), so this
 * hook only ever runs inside a "data-analysis" flow session's own container.
 * No runtime flow check needed inside the hook itself.
 *
 * Currently just a marker (a distinguishable log line) proving the wiring —
 * that a "Phân tích dữ liệu" session really does load and run this plugin's
 * hook on every step, not silently falling back to plain default behavior.
 * Replacing the marker with real behavior (tool policy, extra planning
 * steps, retry/compaction differences, ...) is follow-up work once this is
 * confirmed working end to end.
 */
export function apply(ctx: Context) {
  ctx.on('agent/pre-step', (payload, next) => {
    console.log(
      JSON.stringify({
        event: 'fox-harness-flow-data-analysis/pre-step',
        turn: payload.turn,
        step: payload.step,
      }),
    )
    return next()
  })
}
