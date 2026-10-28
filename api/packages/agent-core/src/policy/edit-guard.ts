// A turn must not end with a file change that failed and was never redone (user, 2026-10-28: "fix agent như thế nào
// là hợp lý"). A live chat asked to keep one of four charts: one `edit` failed ("old_string was not found"), the
// model went on, and closed the turn saying the work was done; the file was left half-changed and broken.
//
// When a turn is about to close (`agent/turn-stopping`, run by our loop, packages/agent-core/src/loop/agent.ts),
// this reads the turn's own tool calls from the session. Each failed change counts on its own, not per file: in that
// chat a later, different `edit` of the same file succeeded and hid the failed one. A failed `edit` counts as redone
// when a later `edit` of the same file with the same new_string (the same change, its old_string corrected) or a
// later `write` of the whole file succeeded; a failed `write`, when a later `write` of it succeeded. Anything left
// gets one reminder naming it, queued as next-step input, which reopens the turn for another step; the agent fixes
// the file or tells the user what was not done. One reminder per turn, so a model that still cannot fix it ends the
// turn as before instead of looping. Advisory only, like dsh-repeat-tool-reminder: no call is blocked or rewritten.
// Plugin-sourced, so the chat (Conversation.tsx) does not show it to the user.

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ToolResultMessage } from '@deepseek-ai/dsh-llm'

const FILE_CHANGE_TOOLS = new Set(['edit', 'write'])
const ERROR_PREVIEW_CHARS = 200

interface Change {
  tool: string
  path: string
  /** edit: the replacement it was meant to put in (`new_string`) */
  intended?: string
}

interface Unfinished extends Change {
  error: string
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : '')).join(' ')
}

function changeOf(name: string, argumentsJson: string): Change | undefined {
  if (!FILE_CHANGE_TOOLS.has(name)) return undefined
  try {
    const args = JSON.parse(argumentsJson) as { file_path?: unknown; new_string?: unknown }
    if (typeof args.file_path !== 'string' || !args.file_path) return undefined
    return { tool: name, path: args.file_path, ...(name === 'edit' && typeof args.new_string === 'string' ? { intended: args.new_string } : {}) }
  } catch {
    return undefined // arguments the model got wrong fail the call itself; nothing to name here
  }
}

/** Whether `done`, a later successful call, redid the failed change `failed`. */
function redoes(done: Change, failed: Change): boolean {
  if (done.path !== failed.path) return false
  if (done.tool === 'write') return true
  return failed.tool === 'edit' && done.intended !== undefined && done.intended.trim() === failed.intended?.trim()
}

/** The file changes that failed in this turn and were not redone later in it, in the order they failed. */
export function unfinishedChanges(events: readonly { type: string; data: unknown }[], turn: number): Unfinished[] {
  const calls = new Map<string, Change>()
  let open: Unfinished[] = []
  for (const event of events) {
    const data = event.data as { turn?: number } | undefined
    if (data?.turn !== turn) continue
    if (event.type === 'tool/call') {
      const call = event.data as { callId: string; name: string; arguments: string }
      const change = changeOf(call.name, call.arguments)
      if (change) calls.set(call.callId, change)
    } else if (event.type === 'tool/result') {
      // the message's one block carries the outcome (dsh-llm ToolResultBlock); its source names the call
      const message = (event.data as { message: ToolResultMessage }).message
      const block = message.content[0]
      const change = calls.get(message.source.callId)
      if (!change || block?.type !== 'tool-result') continue
      if (block.isError) open.push({ ...change, error: textOf(block.content).trim().slice(0, ERROR_PREVIEW_CHARS) })
      else open = open.filter((failed) => !redoes(change, failed))
    }
  }
  return open
}

export function reminderText(unfinished: Unfinished[]): string {
  const lines = unfinished.map((entry) => {
    // which of possibly several edits of the file: the first line it was meant to put in
    const first = entry.intended?.split('\n').find((line) => line.trim())?.trim().slice(0, 80)
    return `- ${entry.tool} ${entry.path}${first ? ` (meant to put in "${first}")` : ''}: ${entry.error || 'failed'}`
  })
  return [
    '<system-reminder>',
    'These file changes failed in this turn and were not redone, so the files do not contain them:',
    ...lines,
    'Before finishing: read each file again and make the change with text copied exactly from what you read (or rewrite the file with `write`), then check the result. If a change cannot be made, tell the user plainly which one is missing. Do not say the work is complete while a change is missing.',
    '</system-reminder>',
  ].join('\n')
}

export function apply(ctx: Context) {
  // the last turn each agent was reminded in: one reminder per turn
  const reminded = new WeakMap<Agent, number>()

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (signal.aborted || reminded.get(agent) === turn) return
    const unfinished = unfinishedChanges(agent.session.events, turn)
    if (unfinished.length === 0) return
    reminded.set(agent, turn)
    agent.inject(
      createUserMessage({
        content: [{ type: 'text', text: reminderText(unfinished) }],
        source: { kind: 'plugin', plugin: 'fox-edit-guard', form: 'notice', summary: `${unfinished.length} unfinished file change(s)` },
      }),
    )
  })
}
