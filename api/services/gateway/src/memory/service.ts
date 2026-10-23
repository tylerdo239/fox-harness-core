// The memory service the gateway's routes call (docs/memory-plugin-plan.md §4): who may use it, the per-member work
// queue, usage rows and log lines around MemoryBase (core.ts).
//
// - recall (start of a turn, on the turn's path): reads what is committed; never waits for a member's queue.
// - remember (end of a turn): queued per member (one member's writes apply in order), at most MEMORY_CONCURRENCY
//   members at once so extraction never takes all of the model from live chats; the route answers 202 at once.
// - maintain: after a remember, at most every MEMORY_MAINTAIN_HOURS per member.
// Every model and embedding call is recorded in discovery_usage_steps (purpose memory-*); logs carry counts, never text.
import { config } from '../config.ts'
import { getSessionRuntimeInfo } from '../db.ts'
import { errorFields, log } from '../log.ts'
import { recordMemoryUsage } from '../runtime/usage.ts'
import { MemoryBase } from './core.ts'
import type { Message } from './extract.ts'
import { HttpReranker, LLMReranker, type ModelCall, NoReranker, OpenAICompatEmbedder, OpenAICompatModel, type Reranker } from './llm.ts'
import { Qdrant } from './qdrant.ts'
import { SCHEMA } from './schema.ts'
import * as store from './store.ts'

/** Flows whose chats are not remembered: Data Studio answers from company data, its figures would go stale. */
const EXCLUDED_FLOWS = new Set(['data-studio'])

let base: MemoryBase | undefined

/** The memory, built on first use from the gateway's config. */
export function memory(): MemoryBase {
  if (!base) {
    const model = new OpenAICompatModel()
    const reranker: Reranker = config.memory.rerank === 'http' ? new HttpReranker() : config.memory.rerank === 'llm' ? new LLMReranker(model) : new NoReranker()
    base = new MemoryBase(SCHEMA, model, new OpenAICompatEmbedder(), new Qdrant(), reranker, config.memory.language,
      { maxTokens: config.memory.maxTokens, entities: 30, userEntities: 12, minEventScore: 0.25, eventShare: 0.3 })
  }
  return base
}

/** For tests: a MemoryBase with fakes. */
export function setMemoryForTests(next: MemoryBase | undefined): void {
  base = next
}

export function memoryConfigured(): boolean {
  return config.memory.enabled && Boolean(config.memory.qdrantUrl) && Boolean(config.memory.llmBaseUrl) && Boolean(config.memory.llmModel) && Boolean(config.memory.embedBaseUrl)
}

// ---- switches -------------------------------------------------------------------------------------------------------

export async function orgEnabled(): Promise<boolean> {
  if (config.memory.orgForced !== undefined) return config.memory.orgForced
  return (await store.getSwitch('org').catch(() => undefined)) ?? false
}

/** True when MEMORY_ORG decides the organization switch (the admin's switch is read-only). */
export function orgLocked(): boolean {
  return config.memory.orgForced !== undefined
}

export async function userEnabled(userId: number): Promise<boolean> {
  return (await store.getSwitch(`user:${String(userId)}`).catch(() => undefined)) ?? true
}

export async function chatEnabled(sessionId: string): Promise<boolean> {
  return (await store.getSwitch(`session:${sessionId}`).catch(() => undefined)) ?? true
}

/**
 * Whether `userId` may use memory in `sessionId` now: memory configured and on for the organization, the member and
 * the chat; the chat is the member's own (checked against discovery_sessions, whatever the runtime said) and not in an
 * excluded flow. Returns the chat's flow when allowed.
 */
export async function allowed(userId: number, sessionId: string): Promise<{ ok: true; flow: string } | { ok: false; reason: string }> {
  if (!memoryConfigured()) return { ok: false, reason: 'not_configured' }
  const info = await getSessionRuntimeInfo(sessionId)
  if (!info || info.ownerId !== userId) return { ok: false, reason: 'not_owner' }
  if (EXCLUDED_FLOWS.has(info.flow)) return { ok: false, reason: 'flow' }
  if (!(await orgEnabled())) return { ok: false, reason: 'org_off' }
  if (!(await userEnabled(userId))) return { ok: false, reason: 'user_off' }
  if (!(await chatEnabled(sessionId))) return { ok: false, reason: 'chat_off' }
  return { ok: true, flow: info.flow }
}

// ---- recall -----------------------------------------------------------------------------------------------------------

/** The memory block for the start of a turn ('' when there is nothing, or memory is off for this chat). */
export async function recall(input: { userId: number; sessionId: string; query: string; turn?: number }): Promise<{ text: string; tokens: number }> {
  const started = Date.now()
  const permitted = await allowed(input.userId, input.sessionId)
  if (!permitted.ok) {
    if (permitted.reason === 'not_owner') log('memory_refused', { userId: input.userId, sessionId: input.sessionId })
    return { text: '', tokens: 0 }
  }
  const calls: ModelCall[] = []
  try {
    const block = await memory().context(input.userId, input.sessionId, input.query.slice(0, 1000), calls)
    log('memory_recall', { userId: input.userId, sessionId: input.sessionId, ms: Date.now() - started, tokens: block.tokens, entities: block.entities, events: block.events })
    return { text: block.text, tokens: block.tokens }
  } finally {
    void recordMemoryUsage({ userId: input.userId, sessionId: input.sessionId, ...(input.turn === undefined ? {} : { turn: input.turn }), calls })
  }
}

// ---- remember: the per-member queue --------------------------------------------------------------------------------

const queues = new Map<number, Promise<void>>()
const maintainedAt = new Map<number, number>()
let running = 0
const waiting: (() => void)[] = []

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= config.memory.concurrency) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await work()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/** Queues a turn's exchange for extraction; resolves when done (the route does not wait). */
export function remember(input: { userId: number; sessionId: string; messages: Message[]; context?: Message[]; turn?: number; at?: string }): Promise<void> {
  const previous = queues.get(input.userId) ?? Promise.resolve()
  const next = previous.then(() => slot(() => rememberNow(input))).catch((error: unknown) => {
    log('memory_extract_failed', { userId: input.userId, sessionId: input.sessionId, ...errorFields(error) })
  })
  queues.set(input.userId, next)
  void next.finally(() => {
    if (queues.get(input.userId) === next) queues.delete(input.userId)
  })
  return next
}

async function rememberNow(input: { userId: number; sessionId: string; messages: Message[]; context?: Message[]; turn?: number; at?: string }): Promise<void> {
  // checked again at run time: the switch may have been turned off while the turn waited in the queue
  if (!(await allowed(input.userId, input.sessionId)).ok) return
  const started = Date.now()
  const calls: ModelCall[] = []
  try {
    // A failed model call is retried once inside llm.ts (timeouts, 429, 5xx). Not the whole ingest: part of it may
    // already be stored, and a second pass would add it again. A turn that still fails is skipped and logged.
    const result = await memory().ingest({ userId: input.userId, sessionId: input.sessionId, messages: input.messages, ...(input.context ? { context: input.context } : {}), ...(input.at ? { at: input.at } : {}) }, calls)
    log('memory_remember', { userId: input.userId, sessionId: input.sessionId, ms: Date.now() - started, ...result })
  } finally {
    await recordMemoryUsage({ userId: input.userId, sessionId: input.sessionId, ...(input.turn === undefined ? {} : { turn: input.turn }), calls })
  }
  await maintainIfDue(input.userId)
}

async function maintainIfDue(userId: number): Promise<void> {
  const every = config.memory.maintainHours * 3_600_000
  if (Date.now() - (maintainedAt.get(userId) ?? 0) < every) return
  maintainedAt.set(userId, Date.now())
  const calls: ModelCall[] = []
  const started = Date.now()
  try {
    const result = await memory().maintain(userId, calls)
    log('memory_maintain', { userId, ms: Date.now() - started, ...result })
  } catch (error) {
    log('memory_maintain_failed', { userId, ...errorFields(error) })
  } finally {
    await recordMemoryUsage({ userId, calls })
  }
}

/** Waits until every queued turn has been processed (shutdown, tests). */
export async function drained(): Promise<void> {
  while (queues.size > 0) await Promise.all([...queues.values()])
}

// ---- the member's own view, and deletes -----------------------------------------------------------------------------

export async function forChatDeleted(userId: number, sessionId: string): Promise<void> {
  if (!memoryConfigured()) return
  try {
    const removed = await memory().clear(userId, { sessionId })
    await store.deleteSwitch(`session:${sessionId}`)
    if (removed > 0) log('memory_chat_cleared', { userId, sessionId, removed })
  } catch (error) {
    log('memory_chat_clear_failed', { userId, sessionId, ...errorFields(error) })
  }
}

export async function withCalls<T>(userId: number, work: (calls: ModelCall[]) => Promise<T>): Promise<T> {
  const calls: ModelCall[] = []
  try {
    return await work(calls)
  } finally {
    void recordMemoryUsage({ userId, calls })
  }
}
