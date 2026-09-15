import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-token-meter'
import z from '@deepseek-ai/schemastery'

import { collapseOldTurns } from './collapse.ts'

export const name = 'fox-harness-flow-data-analysis'
export const inject = ['systemPrompt', 'tokenMeter']

export interface Config {
  maxSteps: number
  turnDeadlineMs: number
  keepRecentTurns: number
}

export const Config: z<Config> = z.object({
  maxSteps: z.number().step(1).min(1).default(8).description('Model calls per turn before the model must answer (RLM max_iterations).'),
  turnDeadlineMs: z.number().step(1).min(1).default(600_000).description('Turn duration before the model must answer (RLM turn deadline).'),
  keepRecentTurns: z.number().step(1).min(0).default(2).description('Most recent turns whose tool steps stay in full for the model; older ones collapse to a note.'),
})

/**
 * Companion plugin for the "data-analysis" flow — NOT a competing agent loop
 * (docs/data-analysis-flow-plan.md). Listed only in
 * @fox-harness/profile-template-data-analysis's `bundles`, so it only runs in
 * that flow's containers.
 *
 * Adds the data-analysis working rules (docs/rlm-transfer-plan.md, giai đoạn 3),
 * adapted from agent-core's bundles/prompts/prompt-rlm-data-agent
 * (evidence-policy.md, turn-policy.md). Its repl-protocol.md/completion.md are
 * dropped: here the model calls the `python` tool instead of writing
 * ```repl``` blocks.
 */
const DATA_ANALYSIS = `## Data analysis workspace
The user's data files are in the working directory ({{cwd}}).
- Use the \`python\` tool for every computation on data, and for exact arithmetic, counting or sorting — never work numbers out by hand.
- Answer in the language of the user's latest message: an English question gets an English answer, a Vietnamese question a Vietnamese answer.
- When the user does not name a file, check \`list_datasets()\` and work on the dataset that is there; ask which one only when several fit and the choice changes the answer.
- Inside the \`python\` tool (they are Python functions, not tools): run \`list_datasets()\` to see the files and \`profile_dataset("<file>")\` once before analysing a dataset; load it with \`load_dataset("<file>")\`. To profile or explore a dataset, call \`profile_dataset("<file>")\` first — also when a skill is loaded — and build on its output instead of hand-writing the same summary.
- Python state persists between calls and turns, and a note lists the variables in memory. Reuse them instead of reloading files or recomputing; reload only when the note says the session restarted. Keep a cleaned dataset in one variable and build on it, so every turn works on the same data.
- Tool steps of older turns may be collapsed to a short note; \`print(history(n))\` inside \`python\` shows turn n in full (messages, code, outputs).
- When a request refers to an earlier result, reuse the value already stated in the conversation and copy its digits exactly. Recompute only when the variables behind it are gone, and then with the same definition and code as before (\`history(n)\`); say so if the new value differs.
- Base every conclusion on data you inspected, computations you ran, or tool results. Never invent columns, values, files or sources.
- Run checks proportionate to the claim: shape, types, missing values, duplicates, ranges, and reconcile important totals.
- Keep printed output small: aggregates and a few rows, never whole tables. Save charts and files only with \`save_artifact()\` (open matplotlib figures are saved automatically) — never write into the working directory directly, e.g. \`plt.savefig("chart.png")\` — and name the returned paths in the answer.
- If a call fails, read the error and change approach; do not repeat an identical call.
- Installed Python libraries: pandas, numpy, scipy, scikit-learn, statsmodels, matplotlib, seaborn, duckdb, lightgbm, xgboost, pyarrow, openpyxl, pillow. Never try to install packages; if a task needs another library (for example torch), tell the user and solve it with the installed ones.
- Current-event and real-world facts need \`web_search\` evidence, not memory.
- When a skill in the catalog clearly matches the task, load it with the \`skill\` tool before starting.
- In the final answer, state the result first, then material assumptions, data limitations and remaining uncertainty.
- When asked to write a report, model card or brief, write it in full in the answer itself. Save it as a file only when the user asks for a file, and then with \`save_artifact()\`.`

// Step limit and turn deadline, as agent-core's loop-rlm (max_iterations 8,
// turn deadline 600 s). Past either, the model gets one more step with this
// note — like RLM's exhaustion fallback, a partial answer marked incomplete
// rather than running on — and a turn that still calls tools after it is closed.
const WRAP_UP =
  'The step or time limit for this turn is reached. Do not call any more tools. Answer now from the results you already have, and say clearly that the result is incomplete and what is still unverified.'

export function apply(ctx: Context, config: Config) {
  ctx.systemPrompt.section({ name: 'fox:data-analysis', order: 30, text: DATA_ANALYSIS })

  const turns = new Map<string, { turn: number; startedAt: number; wrappedUp: boolean }>()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let state = turns.get(payload.agent.id)
    if (state?.turn !== payload.turn) {
      state = { turn: payload.turn, startedAt: Date.now(), wrappedUp: false }
      turns.set(payload.agent.id, state)
    }
    if (payload.step <= config.maxSteps && Date.now() - state.startedAt <= config.turnDeadlineMs) return decision
    if (state.wrappedUp) return { kind: 'reject' }
    state.wrappedUp = true
    const note = createUserMessage({ content: [{ type: 'text', text: WRAP_UP }], source: { kind: 'plugin', plugin: name } })
    return { kind: 'enter', messages: [...decision.messages, note] }
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    collapseOldTurns(agent.session, ctx.tokenMeter, config.keepRecentTurns, name)
  })
}
