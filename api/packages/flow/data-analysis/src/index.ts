import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-token-meter'
import '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { collapseOldTurns } from './collapse.ts'
import { datasetCardsNote, retainedDatasetNote } from './datasets.ts'
import { reconcileWorkspace } from './reconcile.ts'

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
// Also how compaction.ts tells a data-analysis agent apart: only this flow's prompt carries it.
export const WORKSPACE_HEADING = '## Data analysis workspace'
const DATA_ANALYSIS = `${WORKSPACE_HEADING}
The user's data files are in the working directory ({{cwd}}).
- Use the \`python\` tool for every computation on data, and for exact arithmetic, counting or sorting — never work numbers out by hand.
- Answer in the language of the user's latest message: an English question gets an English answer, a Vietnamese question a Vietnamese answer.
- When the user does not name a file, work on the dataset that is there (the "Datasets in this project" note, or \`list_datasets()\` without one); ask which one only when several fit and the choice changes the answer.
- Inside the \`python\` tool (they are Python functions, not tools): load a dataset with \`load_dataset("<file>")\`. A "Datasets in this project" note already gives each uploaded file's rows, columns, types and missing values: build on it, and do not run \`list_datasets()\` or \`profile_dataset()\` just to learn those again. Without that note, run \`list_datasets()\` to see the files and \`profile_dataset("<file>")\` once before analysing a dataset. To profile or explore a dataset beyond the note (distributions, value ranges), call \`profile_dataset("<file>")\` — also when a skill is loaded — and build on its output instead of hand-writing the same summary.
- Python state persists between calls and turns, and a note lists the variables in memory. Reuse them instead of reloading files or recomputing; reload only when the note says the session restarted. Keep a cleaned dataset in one variable and build on it, so every turn works on the same data.
- Tool steps of older turns may be collapsed to a short note; \`print(history(n))\` inside \`python\` shows turn n in full (messages, code, outputs).
- If the conversation was compacted, the checkpoint's \`## Standing instructions\` section is still in force: re-read it before answering and keep every rule in it (answer format, rounding, required closing line, things to avoid), exactly as if the user had just repeated it.
- When a request refers to an earlier result, reuse the value already stated in the conversation and copy its digits exactly. Recompute only when the variables behind it are gone, and then with the same definition and code as before (\`history(n)\`); say so if the new value differs.
- Base every conclusion on data you inspected, computations you ran, or tool results. Never invent columns, values, files or sources. If the answer needs a value from the data and no tool result in this turn contains it, call \`python\` before answering — do not guess it from memory or from an example.
- Run checks proportionate to the claim: shape, types, missing values, duplicates, ranges, and reconcile important totals.
- A result of 0, 100%, -100%, an empty table or \"no data\" is usually a sign that something was read, filtered or joined wrongly, not a finding: before stating it, run one check (row count, the column list, \`list_datasets()\`) and say what that check showed.
- Keep printed output small: aggregates and a few rows, never whole tables. Save charts and files only with \`save_artifact()\` (open matplotlib figures are saved automatically) — never write into the working directory directly, e.g. \`plt.savefig("chart.png")\` — and name the returned paths in the answer.
- If a call fails, read the error and change approach; do not repeat an identical call.
- Installed Python libraries: pandas, numpy, scipy, scikit-learn, statsmodels, matplotlib, seaborn, duckdb, lightgbm, xgboost, pyarrow, openpyxl, pillow. Never try to install packages; if a task needs another library (for example torch), tell the user and solve it with the installed ones.
- Current-event and real-world facts need \`web_search\` evidence, not memory.
- When a skill in the catalog clearly matches the task, load it with the \`skill\` tool before starting.
- When a loaded skill bundles a script that already does the job (\`scripts/*.py\`, e.g. profile_data.py, funnel_analyzer.py), run it instead of writing equivalent code again: inside \`python\`, \`subprocess.run([sys.executable, "<full path of the script>", ...], capture_output=True, text=True)\` and print its stdout and stderr. When the user asks for a skill's script, run exactly that script; its code never enters the conversation, only its output.
- Before the final answer, run one adversarial check on the number the answer rests on: recompute it a different way (a different filter, join or aggregation) in a \`python\` call — in the same cell as the main computation is fine — and say what its printed output showed. A check counts only if a tool result in this turn shows it: never present code you did not run, or a match you did not see, as a check.
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

  // WeakMap, not Map<id,…>: one runtime hosts many sessions for a long time, and an entry must go with its agent.
  const turns = new WeakMap<object, { turn: number; startedAt: number; wrappedUp: boolean }>()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let state = turns.get(payload.agent)
    if (state?.turn !== payload.turn) {
      state = { turn: payload.turn, startedAt: Date.now(), wrappedUp: false }
      turns.set(payload.agent, state)
    }
    if (payload.step <= config.maxSteps && Date.now() - state.startedAt <= config.turnDeadlineMs) return decision
    if (state.wrappedUp) return { kind: 'reject' }
    state.wrappedUp = true
    const note = createUserMessage({ content: [{ type: 'text', text: WRAP_UP }], source: { kind: 'plugin', plugin: name } })
    return { kind: 'enter', messages: [...decision.messages, note] }
  })

  // Dataset cards: the uploaded tables' schema, pushed before the model asks (datasets.ts). Registered after
  // the wrap-up listener, so the wrap-up note stays the last thing the model reads in a step (a waterfall's
  // post-`next()` code runs inner listener first).
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const session = payload.agent.session
    const cwd = session.header.cwd
    const note = cwd === undefined ? undefined : await datasetCardsNote(cwd)
    if (note === undefined || retainedDatasetNote(session, name) === note) return decision
    const message = createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: 'plugin', plugin: name } })
    return { ...decision, messages: [...decision.messages, message] }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || decision.value !== undefined) return decision
    const content = decision.content ?? result.content
    const text = content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

    // What a loaded skill brings with it, listed by full path: the skill tool only gives a base
    // directory and leaves the model to build each path itself. Measured in local-fox-harness-core over
    // 769 stored conversations: 234 skill loads produced 13 reads of a bundled reference (5.6%), and in
    // two runs the model loaded the right skill and then worked from memory.
    if (exec.name === 'skill') {
      const base = SKILL_BASE.exec(text)?.[1]
      const files = base === undefined ? [] : await skillResources(base)
      if (files.length === 0) return decision
      const listing = `Files bundled with this skill — read one with the \`read\` tool when the task calls for it; run a script from \`python\` (see the working rules):\n${files.join('\n')}`
      return { kind: 'accept', content: [...content, { type: 'text', text: listing }] }
    }

    // A model that sent the wrong argument names (measured: \`write\` called with \`path\` instead of
    // \`file_path\`) gets the tool's real ones back, so it retries correctly instead of guessing again.
    if (!result.isError || !text.includes('invalid arguments')) return decision
    const parameters = ctx.tools.schemas().find((schema) => schema.name === exec.name)?.parameters as { required?: unknown; properties?: object } | undefined
    const required = Array.isArray(parameters?.required) ? parameters.required.filter((key): key is string => typeof key === 'string') : []
    const names = required.length > 0 ? required : Object.keys(parameters?.properties ?? {})
    if (names.length === 0) return decision
    const hint = `Argument-name reminder: the tool "${exec.name}" takes ${names.join(', ')} — retry with exactly these names.`
    return { kind: 'accept', content: [...content, { type: 'text', text: hint }] }
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    collapseOldTurns(agent.session, ctx.tokenMeter, config.keepRecentTurns, name)
    // `@mode serial`: this finishes before the turn closes, so the file list the UI fetches on
    // turn/end already sees every file in the chat folder it belongs to. `cwd` is undefined for a
    // chat without a working directory, which has no files to sort.
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const moved = await reconcileWorkspace(cwd, agent.session.id)
    // Tell the model where its files went. Measured in local-fox-harness-core: a file written at the
    // project root was moved into generated/<id>/ here, and the next turn's read of the old path failed
    // "not found" three times in a row — the move was silent. The python tool reports its own moves
    // inside the cell; this covers every other writer.
    if (moved.length === 0) return
    const note = createUserMessage({
      content: [{ type: 'text', text: `Files written into the working directory were moved into this chat's own output folder — use the new paths:\n${moved.map((item) => `- ${item}`).join('\n')}` }],
      source: { kind: 'plugin', plugin: name },
    })
    agent.session.append('user/message', note, { surfaceOp: 'append' })
  })
}

const SKILL_BASE = /Base directory for this skill:\s*(\S+)/
/** Sub-directories of a skill that hold something the model can read or run; `assets/` holds output templates. */
const RESOURCE_DIRS = ['references', 'checklists', 'templates', 'scripts']
/** The widest skill here bundles 20 files; the cap keeps a future one from filling the window. */
const MAX_LISTED = 20

async function skillResources(base: string): Promise<string[]> {
  const found: string[] = []
  for (const dir of RESOURCE_DIRS) {
    const entries = await readdir(join(base, dir), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) if (entry.isFile()) found.push(join(base, dir, entry.name))
  }
  return found.sort().slice(0, MAX_LISTED)
}
