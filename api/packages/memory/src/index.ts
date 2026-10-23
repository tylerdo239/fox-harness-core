// Long-term memory, the runtime half (docs/memory-plugin-plan.md §3). Two hooks; everything else is the gateway's
// (services/gateway/src/memory/), so this process keeps holding no database credential.
//
//   start of a turn  `agent/pre-step`, step 1: POST /internal/memory/recall {userId, sessionId, query} and add the
//                    answer as a plugin message (hidden in the chat, a session event — what the model saw stays in
//                    the log). Not re-sent when it is the same as the last one in this chat. Capped at
//                    FOX_MEMORY_RECALL_TIMEOUT_MS (4 s): a timeout or any error = this turn without memory.
//   end of a turn    `session/event` turn/end (completed): the turn's own messages and its final answer go to
//                    POST /internal/memory/remember, with the previous turn's request and answer as read-only
//                    context; never awaited (the gateway answers 202 and queues the work).
//
// Who the member is comes from the agent options the gateway set on connect (`userId`), never from the model; the
// gateway checks the chat's owner again. Idle when FOX_GATEWAY_URL is unset (MEMORY=0).
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-session'

export const name = 'fox-harness-memory'
// `agents`: the member of a session comes from its agent's options (set by the gateway on connect)
export const inject = ['agents']

const GATEWAY = (process.env.FOX_GATEWAY_URL ?? '').replace(/\/+$/, '')
const SECRET = process.env.FOX_INTERNAL_SECRET ?? ''
const RECALL_TIMEOUT_MS = Number(process.env.FOX_MEMORY_RECALL_TIMEOUT_MS ?? 4000)
/** A follow-up this short ("tiếp tục", "làm lại") says nothing to search by: the request before it is added. */
const SHORT_QUERY_CHARS = 40
const MESSAGE_CHARS = 3000
const QUERY_CHARS = 1000
/** Per message of the previous turn sent as context (its answer: the end, where the figures and the question are). */
const CONTEXT_CHARS = 1500
const FOOTER = 'Không nhắc lại bộ nhớ với người dùng. Người dùng xem, sửa và xoá được bộ nhớ trong Cài đặt → Bộ nhớ.'

type Block = { type?: string; text?: string }
type SomeMessage = { role?: string; content?: unknown; source?: { kind?: string } }
type ChatMessage = { role: 'user' | 'assistant'; content: string }
type SomeEvent = { type: string; data: unknown }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text!).join('\n')
}

/** A message the member typed (not a plugin note, a skill body or the runtime context). */
function isHuman(message: SomeMessage | undefined): boolean {
  return message?.role === 'user' && (message.source === undefined || message.source.kind === 'user')
}

/** A turn's human messages and its final answer (the last assistant text). */
function turnText(events: readonly SomeEvent[]): { humans: string[]; answer: string } {
  const humans: string[] = []
  let answer = ''
  for (const item of events) {
    if (item.type === 'user/message') {
      const message = item.data as SomeMessage
      if (!isHuman(message)) continue
      const text = textOf(message.content).trim()
      if (text) humans.push(text)
    } else if (item.type === 'assistant/message') {
      const text = textOf((item.data as { message?: SomeMessage }).message?.content).trim()
      if (text) answer = text
    }
  }
  return { humans, answer }
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: fields.error ? 'error' : 'info', service: 'memory', event, ...fields }))
}

async function post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fox-harness-internal-secret': SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

export function apply(ctx: Context): void {
  if (!GATEWAY) return
  /** sessionId → the last memory block entered in that chat (this process). */
  const lastBlock = new Map<string, string>()

  const memberOf = (sessionId: string): number | undefined => {
    const options = ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0])?.options as { userId?: string } | undefined
    const id = Number(options?.userId)
    return Number.isInteger(id) && id > 0 ? id : undefined
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.step !== 1) return decision
    try {
      const session = payload.agent.session
      // a subagent's session has no row of its own: the parent's turn is what is remembered
      if ((session.header as { parentSession?: unknown }).parentSession !== undefined) return decision
      const userId = memberOf(session.id)
      if (userId === undefined) return decision
      // the request: this turn's human messages, newest first; a short follow-up borrows the one before it
      const asked = [...session.events.filter((e) => e.type === 'user/message').map((e) => e.data as SomeMessage), ...(payload.messages as SomeMessage[])]
        .filter(isHuman).map((m) => textOf(m.content).trim()).filter(Boolean).reverse()
      const unique = [...new Set(asked)]
      const query = (unique[0] !== undefined && unique[0].length < SHORT_QUERY_CHARS && unique[1] !== undefined ? `${unique[1]}\n${unique[0]}` : unique[0] ?? '').slice(0, QUERY_CHARS)
      const res = await post('/internal/memory/recall', { userId, sessionId: session.id, query, turn: payload.turn }, RECALL_TIMEOUT_MS)
      if (!res.ok) {
        log('memory_recall_failed', { sessionId: session.id, status: res.status })
        return decision
      }
      const { text } = (await res.json()) as { text?: string }
      const block = (text ?? '').trim()
      if (!block || lastBlock.get(session.id) === block) return decision
      lastBlock.set(session.id, block)
      const reminder = createUserMessage({ content: [{ type: 'text', text: `${block}\n${FOOTER}` }], source: { kind: 'plugin', plugin: name } })
      return { ...decision, messages: [...decision.messages, reminder] }
    } catch (error) {
      log('memory_recall_failed', { error: error instanceof Error ? error.message : String(error) })
      return decision
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const data = event.data as { turn?: number; reason?: { kind?: string } }
    if (data.reason?.kind !== 'completed') return
    if ((session.header as { parentSession?: unknown }).parentSession !== undefined) return
    const userId = memberOf(session.id)
    if (userId === undefined) return
    const events = session.events
    let start = events.length - 1
    while (start > 0 && events[start]!.type !== 'turn/start') start -= 1
    const { humans, answer } = turnText(events.slice(start))
    if (humans.length === 0) return
    const messages: ChatMessage[] = humans.map((text) => ({ role: 'user' as const, content: text.slice(0, MESSAGE_CHARS) }))
    if (answer) messages.push({ role: 'assistant', content: answer.slice(0, MESSAGE_CHARS) })
    // The previous turn, read-only for the extractor: a figure the assistant proposed there counts once this turn's
    // request accepts or builds on it — never from the assistant's word alone.
    let previous = start - 1
    while (previous > 0 && events[previous]!.type !== 'turn/start') previous -= 1
    const before = previous >= 0 && previous < start ? turnText(events.slice(previous, start)) : { humans: [], answer: '' }
    const context: ChatMessage[] = []
    const lastAsked = before.humans[before.humans.length - 1]
    if (lastAsked) context.push({ role: 'user', content: lastAsked.slice(0, CONTEXT_CHARS) })
    if (before.answer) context.push({ role: 'assistant', content: before.answer.slice(-CONTEXT_CHARS) })
    void post('/internal/memory/remember', { userId, sessionId: session.id, messages, ...(context.length > 0 ? { context } : {}), turn: data.turn, at: new Date(event.time).toISOString() }, 10_000)
      .then((res) => {
        if (!res.ok) log('memory_remember_failed', { sessionId: session.id, status: res.status })
      })
      .catch((error: unknown) => log('memory_remember_failed', { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }))
  })

  // a chat that leaves this process (idle disposal) does not need its last block remembered
  ctx.on('session/disposed', (session) => {
    lastBlock.delete(session.id)
  })
}
