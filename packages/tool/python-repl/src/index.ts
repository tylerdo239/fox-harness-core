import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { PythonKernel, type HostRequest } from './kernel.ts'

export const name = 'fox-harness-tool-python-repl'
export const inject = ['tools']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A tool call the model made that a plugin can run even when no tool by that name is
     * registered. Answer with the call to make instead, or nothing to leave it alone.
     * Dispatched by @fox-harness/dsh-agent-driver's `runStep` (packages/agent-driver/src/agent.ts).
     */
    'fox/resolve-tool-call'(call: ResolvedToolCall): ResolvedToolCall | undefined
  }
}

export interface ResolvedToolCall {
  name: string
  arguments: Record<string, unknown>
}

// Preloaded in every Python session (python/helpers.py). The model calls these as if they
// were tools — `unknown tool "profile_dataset"` in 2 of 2 runs, `list_datasets` over three
// steps of one chat (docs/qa-report-2026-09-15.md V6) — even though the flow prompt says in
// so many words that they are Python functions. The request is unambiguous, and this session
// is exactly where those functions live, so run it there instead of failing the call.
const PYTHON_HELPERS = new Set(['list_datasets', 'load_dataset', 'profile_dataset', 'save_artifact', 'history'])

/** JSON argument value as Python source, the one place JSON and Python literals differ. */
function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(', ')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item)}`).join(', ')}}`
  }
  return JSON.stringify(String(value))
}

const CELL_TIMEOUT_MS = 120_000
const VARIABLES_CLEARED = 'Python variables: none are in memory now.'

// `python` tool for the data-analysis flow (docs/rlm-transfer-plan.md, giai đoạn 2):
// one persistent IPython process per worker container, i.e. per conversation.
export function apply(ctx: Context) {
  const kernel = new PythonKernel()
  ctx.effect(() => () => kernel.stop(), 'fox-harness-tool-python-repl.kernel')

  ctx.tools.register(
    defineTool({
      name: 'python',
      description: [
        'Run Python code in a persistent IPython session that belongs to this conversation.',
        'Variables, imports and loaded data stay available across calls and turns until the session restarts; a note lists the variables in memory.',
        "The working directory holds the user's data files; save outputs only with save_artifact(), never into the working directory itself — files written there are moved to the output folder after the call.",
        'pandas as pd, numpy as np and matplotlib.pyplot as plt are already imported, and so are these helpers: list_datasets(), load_dataset(name=None) → DataFrame, profile_dataset(name=None), save_artifact(path, content) → path under generated/, history(n) → the full record of turn n of this conversation (messages, code, outputs).',
        'Only printed output and the value of the last expression are returned; past 20000 characters only the first 14000 and the last 6000 are kept — print summaries, not whole tables.',
        'Matplotlib figures still open after a successful call, and not saved by the code itself, are saved as PNG files in the output folder and their paths are returned.',
        `A call running longer than ${CELL_TIMEOUT_MS / 1000} seconds stops the session.`,
      ].join(' '),
      parameters: {
        code: { type: 'string', required: true, description: 'Python code to run.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { output: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: value.output }],
      },
      async execute(args, exec) {
        const session = exec.agent?.session
        const cwd = session?.header.cwd ?? process.cwd()
        const host = (request: HostRequest): string => {
          if (session === undefined || request.kind !== 'history') throw new Error(`unsupported host request "${request.kind}"`)
          return renderTurn(session, Number(request.turn))
        }
        const output = await kernel.run(args.code, cwd, CELL_TIMEOUT_MS, exec.signal, session ? turnCount(session) : 0, host)
        return { output }
      },
    }),
  )

  ctx.on('fox/resolve-tool-call', (call) => {
    if (!PYTHON_HELPERS.has(call.name)) return undefined
    const args = Object.entries(call.arguments)
      .map(([key, value]) => `${key}=${pythonLiteral(value)}`)
      .join(', ')
    return { name: 'python', arguments: { code: `${call.name}(${args})` } }
  })

  // Variables note (docs/rlm-transfer-plan.md 12.3 B): RLM's SHOW_VARS() pushed to the model
  // rather than waiting for a call, delivered the way dsh-agent-loop's RuntimeContextProjection
  // delivers runtime context (lib/index.js:26-86) — a user-role snapshot added only when its text
  // differs from the latest one still on the model-visible surface, so it comes back after a
  // collapse or compaction shadows it. After `next()`, to see what a compaction in this step left.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const session = payload.agent.session
    const usedPythonBefore = session.events.some((event) => event.type === 'tool/call' && event.data.name === 'python')
    const current = kernel.variablesNote(usedPythonBefore, turnCount(session))
    const retained = retainedNote(session)
    if (retained === undefined && current === '') return decision
    const text = current || VARIABLES_CLEARED
    if (retained === text) return decision
    const note = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } })
    // Right after this step's own messages, where dsh-agent-loop puts its snapshot, so a note another
    // listener adds (the step-limit wrap-up) stays the last thing the model reads.
    const at = payload.messages.length
    return { ...decision, messages: [...decision.messages.slice(0, at), note, ...decision.messages.slice(at)] }
  })
}

/** Latest variables note still on the surface; `null` when every note is shadowed, `undefined` when none was sent. */
function retainedNote(session: Session): string | null | undefined {
  const surface = new Set(session.surface.nodes)
  let retained: null | undefined
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (event.type !== 'user/message' || !isOwnNote(event.data)) continue
    if (surface.has(event.seq)) return textOf(event.data.content)
    retained = null
  }
  return retained
}

function isOwnNote(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === name
}

// Turns count `turn/start` events, as the collapse in @fox-harness/dsh-flow-data-analysis does:
// the driver restarts `data.turn` at 1 when a chat reopens.
function turnCount(session: Session): number {
  return session.events.filter((event) => event.type === 'turn/start').length
}

/**
 * `history(n)`: turn n rebuilt from the original events of the session log, so a turn collapsed
 * or compacted on the model-visible surface still reads in full.
 */
function renderTurn(session: Session, n: number): string {
  const total = turnCount(session)
  if (!Number.isInteger(n) || n < 1 || n > total) throw new Error(`no turn ${n}: this conversation has turns 1 to ${total}`)
  const parts: string[] = []
  let turn = 0
  for (const event of session.events) {
    if (event.type === 'turn/start') turn += 1
    if (turn < n) continue
    if (turn > n) break
    if (event.type === 'user/message' && isAppendSurfaceEvent(event) && event.data.source.kind === 'user') {
      parts.push(`## User\n${textOf(event.data.content)}`)
    } else if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'text' && block.text.trim()) parts.push(`## Assistant\n${block.text}`)
        if (block.type === 'tool-call') parts.push(`### ${block.name}\n${callText(block.name, block.arguments)}`)
      }
    } else if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      const result = event.data.message.content[0]!
      parts.push(`### ${result.isError ? 'Error' : 'Output'}\n\`\`\`\n${textOf(result.content)}\n\`\`\``)
    }
  }
  return parts.join('\n\n')
}

function callText(tool: string, args: string): string {
  let code: unknown
  try {
    code = (JSON.parse(args || '{}') as { code?: unknown }).code
  } catch {
    // arguments the model left malformed are shown as sent
  }
  return tool === 'python' && typeof code === 'string' ? `\`\`\`python\n${code}\n\`\`\`` : `\`\`\`json\n${args}\n\`\`\``
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}
