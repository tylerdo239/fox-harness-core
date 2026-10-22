// docs/admin-usage-dashboard-plan.md §3: what every chat used, written once as it happens — numbers only, never
// message text. One `step` record per model request (tokens, latency, model, outcome) and one `turn` record per
// turn (duration, how it ended, tool calls and errors), plus `step` records for the model calls the turn made
// elsewhere: the compaction summary and Data Studio's own pipeline (the tool appends them as a `fox/usage` event).
//
// The runtime never talks to the database (policy/quota.ts): records are appended to
// `$FOX_USAGE_DIR/<YYYY-MM-DD>.jsonl` (one folder per runtime shard, set by the gateway's supervisor), and the
// gateway's sweep loads them into MariaDB (services/gateway/src/runtime/usage-ingest.ts). Owner, flow and project
// are added there from discovery_sessions; `userId` rides along for the records that have no session row.
// A failed write is logged and never touches the turn.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { errorFields, log } from './server.ts'

/** One model call of the pipeline behind a tool (Data Studio), as the tool reports it in a `fox/usage` event. */
export interface ToolModelCall {
  purpose?: string
  model?: string
  in?: number
  out?: number
  cacheRead?: number
  reasoning?: number
  ms?: number
  ok?: boolean
}

interface TurnState {
  start: number
  steps: number
  stepStart: Map<number, number>
  /** per tool: calls and failed calls */
  tools: Map<string, { calls: number; errors: number }>
  /** callId → tool name, to file a result under its tool */
  callNames: Map<string, string>
  toolErrors: number
  attachments: number
  /** step numbers after the turn's own, for model calls made by a tool's pipeline or the compaction */
  extraStep: number
}

interface Usage { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number }

const ATTACHED = /\[(?:Attached files in the working directory|Đã đính kèm)[^\]]*?:\s*(\[[^\]]*\])/

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

const int = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)

export class UsageRecorder {
  private readonly turns = new Map<string, TurnState>()
  private queue: Promise<void> = Promise.resolve()
  private madeDir = false

  constructor(private readonly dir: string, private readonly userOf: (sessionId: string) => string | undefined) {}

  observe(sessionId: string, event: { type: string; time: number; data: unknown }): void {
    const data = event.data as Record<string, unknown>
    const key = (turn: unknown) => `${sessionId}:${String(turn)}`
    switch (event.type) {
      case 'turn/start':
        this.turns.set(key(data.turn), { start: event.time, steps: 0, stepStart: new Map(), tools: new Map(), callNames: new Map(), toolErrors: 0, attachments: 0, extraStep: 1000 })
        return
      case 'user/message': {
        const state = this.latest(sessionId)
        const text = JSON.stringify((data as { content?: unknown }).content ?? '')
        const match = ATTACHED.exec(text.replace(/\\"/g, '"'))
        if (state && match) {
          try {
            state.attachments += (JSON.parse(match[1]!) as unknown[]).length
          } catch {
            state.attachments += 1
          }
        }
        return
      }
      case 'step/start': {
        const state = this.turns.get(key(data.turn))
        state?.stepStart.set(int(data.step), event.time)
        return
      }
      case 'assistant/message': {
        const state = this.turns.get(key(data.turn))
        const step = int(data.step)
        if (state) state.steps = Math.max(state.steps, step)
        const usage = data.usage as Usage | undefined
        const source = (data.message as { source?: { model?: string } } | undefined)?.source
        const started = state?.stepStart.get(step) ?? event.time
        this.write({
          kind: 'step',
          t: started,
          ms: Math.max(0, event.time - started),
          sessionId,
          userId: this.userOf(sessionId),
          turn: int(data.turn),
          step,
          purpose: 'turn',
          model: source?.model ?? 'unknown',
          outcome: data.interrupted === true ? 'interrupted' : 'ok',
          in: int(usage?.inputTokens),
          out: int(usage?.outputTokens),
          ...(usage?.cacheReadTokens === undefined ? {} : { cacheRead: int(usage.cacheReadTokens) }),
          ...(usage?.reasoningTokens === undefined ? {} : { reasoning: int(usage.reasoningTokens) }),
          estimated: usage === undefined,
        })
        return
      }
      case 'tool/call': {
        const state = this.turns.get(key(data.turn))
        if (state && typeof data.name === 'string') {
          const entry = state.tools.get(data.name) ?? { calls: 0, errors: 0 }
          entry.calls += 1
          state.tools.set(data.name, entry)
          if (typeof data.callId === 'string') state.callNames.set(data.callId, data.name)
        }
        return
      }
      case 'tool/result': {
        const state = this.turns.get(key(data.turn))
        const block = (data.message as { content?: { isError?: boolean; toolCallId?: string }[] } | undefined)?.content?.[0]
        if (state && block?.isError === true) {
          state.toolErrors += 1
          const name = block.toolCallId === undefined ? undefined : state.callNames.get(block.toolCallId)
          const entry = name === undefined ? undefined : state.tools.get(name)
          if (entry) entry.errors += 1
        }
        return
      }
      case 'fox/usage': {
        // a tool's own pipeline (Data Studio): one record per model call, on the turn that ran the tool
        const calls = (data as { calls?: unknown }).calls
        if (!Array.isArray(calls)) return
        const state = this.latest(sessionId)
        const turn = this.latestTurn(sessionId)
        for (const call of calls as ToolModelCall[]) this.writeExtra(sessionId, turn, state, event.time, call)
        return
      }
      case 'compaction/summary': {
        const usage = data.usage as Usage | undefined
        if (!usage) return
        const state = this.latest(sessionId)
        this.writeExtra(sessionId, this.latestTurn(sessionId), state, event.time, {
          purpose: 'compaction',
          model: typeof data.model === 'string' ? data.model : undefined,
          in: usage.inputTokens,
          out: usage.outputTokens,
          cacheRead: usage.cacheReadTokens,
          reasoning: usage.reasoningTokens,
          ok: true,
        })
        return
      }
      case 'turn/end': {
        const state = this.turns.get(key(data.turn))
        this.turns.delete(key(data.turn))
        if (!state) return // a turn that started before this process (resumed mid-turn): its start is unknown
        const reason = (data.reason as { kind?: string } | undefined)?.kind ?? 'unknown'
        this.write({
          kind: 'turn',
          t: state.start,
          ms: Math.max(0, event.time - state.start),
          sessionId,
          userId: this.userOf(sessionId),
          turn: int(data.turn),
          reason,
          steps: state.steps,
          tools: [...state.tools].map(([name, entry]) => ({ name, ...entry })),
          toolCalls: [...state.tools.values()].reduce((sum, entry) => sum + entry.calls, 0),
          toolErrors: state.toolErrors,
          attachments: state.attachments,
        })
        return
      }
    }
  }

  private latest(sessionId: string): TurnState | undefined {
    let found: TurnState | undefined
    for (const [key, state] of this.turns) if (key.startsWith(`${sessionId}:`)) found = state
    return found
  }

  private latestTurn(sessionId: string): number {
    let turn = 0
    for (const key of this.turns.keys()) if (key.startsWith(`${sessionId}:`)) turn = Math.max(turn, Number(key.split(':')[1]))
    return turn
  }

  private writeExtra(sessionId: string, turn: number, state: TurnState | undefined, time: number, call: ToolModelCall): void {
    const step = state ? state.extraStep++ : 1000 + Math.floor(Math.random() * 1e6)
    const ms = int(call.ms)
    this.write({
      kind: 'step',
      t: time - ms,
      ms,
      sessionId,
      userId: this.userOf(sessionId),
      turn,
      step,
      purpose: typeof call.purpose === 'string' && /^[a-z-]{1,16}$/.test(call.purpose) ? call.purpose : 'data-studio',
      model: typeof call.model === 'string' && call.model !== '' ? call.model.slice(0, 128) : 'unknown',
      outcome: call.ok === false ? 'error' : 'ok',
      in: int(call.in),
      out: int(call.out),
      ...(call.cacheRead === undefined ? {} : { cacheRead: int(call.cacheRead) }),
      ...(call.reasoning === undefined ? {} : { reasoning: int(call.reasoning) }),
      estimated: false,
    })
  }

  private write(record: Record<string, unknown> & { t: number }): void {
    const line = `${JSON.stringify(record)}\n`
    const file = join(this.dir, `${dayOf(record.t)}.jsonl`)
    this.queue = this.queue.then(async () => {
      try {
        if (!this.madeDir) {
          await mkdir(this.dir, { recursive: true })
          this.madeDir = true
        }
        await appendFile(file, line)
      } catch (error) {
        log('usage_write_failed', { file, ...errorFields(error) })
      }
    })
  }

  /** Resolves when every record so far is on disk (shutdown, tests). */
  flush(): Promise<void> {
    return this.queue
  }
}

/** Starts recording when FOX_USAGE_DIR is set (the gateway sets it per runtime shard). */
export function startUsageRecorder(ctx: Context): (() => void) | undefined {
  const dir = process.env.FOX_USAGE_DIR
  if (!dir) return undefined
  const recorder = new UsageRecorder(dir, (sessionId) => (ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0])?.options as { userId?: string } | undefined)?.userId)
  const dispose = ctx.on('session/event', (session, event) => {
    try {
      recorder.observe(session.id, event as { type: string; time: number; data: unknown })
    } catch (error) {
      log('usage_record_failed', errorFields(error))
    }
  })
  return () => {
    dispose()
    void recorder.flush()
  }
}
