// MemoryBase (port of pynote-memory's memory.py, event_store.py and retriever.py; same flow, same constants):
//   ingest      after each turn: prefetch top-K entities → one extraction call → dedup (code, then one LLM call for the
//               near ones) → store events → entity operators → patches / LLM_MERGE → forget on request → re-index.
//   context     at the start of a turn: the memory block within its token budget.
//   maintain    every few hours: TIME_COMPRESS, expiry with reinforcement, merging keys, repairing missing vectors.
//   memories / edit / forget / clear   the member's own view (Settings → Memory).
// Storage: MariaDB rows first (the source of truth), then Qdrant points with the same ids.
import { randomUUID } from 'node:crypto'

import { errorFields, log } from '../log.ts'
import { type Extraction, type ExtractedEvent, Extractor, LANGUAGES, type Message } from './extract.ts'
import {
  consolidateKeys, DEFAULT_COMPRESS, expiryDecisions, mergeText, planCompression, resolveDuplicates, summarizeTimeline, summaryRecord, type CompressConfig,
} from './lifecycle.ts'
import type { ChatModel, Embedder, ModelCall, Reranker } from './llm.ts'
import { NoReranker } from './llm.ts'
import { applyPatch } from './patch.ts'
import { keywordPointId, type Owner, Qdrant } from './qdrant.ts'
import { DEFAULT_WEIGHTS, finalScore, parseTime, type RankWeights } from './rank.ts'
import { entitySchema, eventSchema, type EntitySchema, type MemorySchema, type Scope, triggeredBy } from './schema.ts'
import * as store from './store.ts'
import type { Entity, EventRecord } from './store.ts'
import { CHARS_PER_TOKEN, fold, sparseQuery, sparseVector } from './text.ts'
import { resolveWhen, utcDate } from './timeparse.ts'

/** A fact key that names a time (folded): its value is a time phrase to resolve. */
const TIME_KEY = /\b(han|ngay|thoi han|thoi diem|thoi gian|deadline|lich|khi nao)\b/

/** Hidden property keeping an entity key as written (for display). */
export const LABEL = '_label'

export interface ContextBudget {
  maxTokens: number
  /** keyed chat entities shown (besides single ones like ChatBrief) */
  entities: number
  userEntities: number
  minEventScore: number
  /** share of the budget always kept for events */
  eventShare: number
}

export interface Options {
  /** related entities given to the extractor (besides the chat's single ones) */
  prefetchK: number
  /** at or above: a duplicate without asking */
  autoDuplicate: number
  /** [ask, auto): ask the model */
  askDuplicate: number
  llmDedup: boolean
  /** a patch that does not locate → LLM_MERGE */
  llmMerge: boolean
  /** an entity text longer than this → LLM_MERGE shortens it */
  maxTextChars: number
}

export interface RetrievalConfig {
  denseK: number
  sparseK: number
  alphaDense: number
  primaryQuota: number
  keywordQuota: number
  keywordTop: number
  keywordMinSimilarity: number
  rerankBlend: number
  minScore: number
  reinforce: boolean
}

export const DEFAULT_BUDGET: ContextBudget = { maxTokens: 1600, entities: 30, userEntities: 12, minEventScore: 0.25, eventShare: 0.3 }
export const DEFAULT_OPTIONS: Options = { prefetchK: 12, autoDuplicate: 0.97, askDuplicate: 0.85, llmDedup: true, llmMerge: true, maxTextChars: 1200 }
export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  denseK: 20, sparseK: 20, alphaDense: 0.6, primaryQuota: 8, keywordQuota: 3, keywordTop: 5, keywordMinSimilarity: 0.8, rerankBlend: 0.5, minScore: 0.25, reinforce: true,
}

export interface IngestResult {
  eventsAdded: number
  duplicates: number
  demoted: number
  dropped: number
  forgotten: number
  noiseMessages: number
  segments: number
  entityUpdates: number
  patchesApplied: number
  patchesMerged: number
}

const emptyResult = (): IngestResult => ({ eventsAdded: 0, duplicates: 0, demoted: 0, dropped: 0, forgotten: 0, noiseMessages: 0, segments: 0, entityUpdates: 0, patchesApplied: 0, patchesMerged: 0 })

function addResult(a: IngestResult, b: IngestResult): IngestResult {
  const out = { ...a }
  for (const key of Object.keys(out) as (keyof IngestResult)[]) out[key] += b[key]
  return out
}

export interface Retrieved {
  record: EventRecord
  score: number
  path: 'primary' | 'keyword'
}

export interface MemoryContext {
  text: string
  tokens: number
  entities: number
  events: number
}

export interface MemoryItem {
  id: string
  scope: Scope
  sessionId: string
  schema: string
  text: string
  updatedAt: string
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)

const byMax = (values: Map<string, number>): Map<string, number> => {
  const top = Math.max(0, ...values.values())
  return top > 0 ? new Map([...values].map(([k, v]) => [k, v / top])) : new Map()
}
const minMax = (values: Map<string, number>): Map<string, number> => {
  if (values.size === 0) return new Map()
  const lo = Math.min(...values.values())
  const hi = Math.max(...values.values())
  if (hi - lo < 1e-9) return new Map([...values.keys()].map((k) => [k, 1]))
  return new Map([...values].map(([k, v]) => [k, (v - lo) / (hi - lo)]))
}

export class MemoryBase {
  readonly extractor: Extractor

  constructor(
    readonly schema: MemorySchema,
    readonly model: ChatModel,
    readonly embedder: Embedder,
    readonly qdrant: Qdrant,
    readonly reranker: Reranker = new NoReranker(),
    readonly language = 'vi',
    readonly budget: ContextBudget = DEFAULT_BUDGET,
    readonly options: Options = DEFAULT_OPTIONS,
    readonly retrieval: RetrievalConfig = DEFAULT_RETRIEVAL,
    readonly compress: CompressConfig = DEFAULT_COMPRESS,
    readonly weights: RankWeights = DEFAULT_WEIGHTS,
  ) {
    this.extractor = new Extractor(schema, model, language)
  }

  private get languageName(): string {
    return LANGUAGES[this.language] ?? (this.language === 'auto' ? 'tiếng Việt' : this.language)
  }

  /** Embeds and makes sure the collections exist (dims come from the first vector). */
  private async embed(texts: string[], action: 'add' | 'search', calls: ModelCall[]): Promise<number[][]> {
    const vectors = await this.embedder.embed(texts, action, calls)
    if (vectors[0]) await this.qdrant.ensure(vectors[0].length)
    return vectors
  }

  // ---- event store: MariaDB + Qdrant ---------------------------------------------------------------------------

  private sparseText(record: EventRecord): string {
    // topic, keywords and property values go into the keyword index too
    return [record.content, record.topic, record.keywords.join(' '), Object.values(record.props).map(String).join(' ')].join(' ')
  }

  async addEvent(record: EventRecord, calls: ModelCall[]): Promise<EventRecord> {
    record.content = record.content.slice(0, 1000)
    await store.insertEvent(record)
    try {
      const [vector] = await this.embed([record.content], 'add', calls)
      await this.qdrant.upsert(this.qdrant.events, [{
        id: record.id,
        vector: { dense: vector!, terms: sparseVector(this.sparseText(record)) },
        payload: { user_id: record.userId, session_id: record.scope === 'session' ? record.sessionId : '', scope: record.scope, type: record.type, level: record.level },
      }])
      if (record.keywords.length > 0) await this.linkKeywords(record, vector!)
    } catch (error) {
      // the row is there; the 6-hourly repair puts the vector back
      log('memory_index_failed', { eventId: record.id, ...errorFields(error) })
    }
    return record
  }

  /** The keyword graph: a keyword's vector = the running mean of the vectors of the events carrying it. */
  private async linkKeywords(record: EventRecord, vector: number[]): Promise<void> {
    const keywords = await store.linkKeywords(record.userId, record.id, record.keywords)
    const ids = keywords.map((k) => keywordPointId(record.userId, k))
    const existing = await this.qdrant.vectors(this.qdrant.keywords, ids)
    const labels = new Map(record.keywords.map((k) => [fold(k).slice(0, 100), k.trim()]))
    await this.qdrant.upsert(this.qdrant.keywords, keywords.map((keyword, i) => {
      const old = existing.get(ids[i]!)
      const n = Number(old?.payload.n ?? 0)
      const mean = old ? old.dense.map((v, j) => (v * n + vector[j]!) / (n + 1)) : vector
      return { id: ids[i]!, vector: { dense: mean }, payload: { user_id: record.userId, keyword, label: labels.get(keyword) ?? keyword, n: n + 1 } }
    }))
  }

  async deleteEvents(userId: number, ids: string[]): Promise<number> {
    const { ids: removed, orphanKeywords } = await store.deleteEvents(userId, ids)
    await this.qdrant.deleteIds(this.qdrant.events, removed).catch((error: unknown) => log('memory_unindex_failed', errorFields(error)))
    await this.qdrant.deleteIds(this.qdrant.keywords, orphanKeywords.map((k) => keywordPointId(userId, k))).catch(() => undefined)
    return removed.length
  }

  /** Live events of `owner` nearest to `query` (cosine). */
  async denseSearch(query: string, owner: Owner, topK: number, calls: ModelCall[], now = new Date()): Promise<[EventRecord, number][]> {
    const [vector] = await this.embed([query], 'search', calls)
    const hits = await this.qdrant.searchEventsDense(owner, vector!, topK)
    const records = new Map((await store.getEvents(owner.userId, hits.map((h) => h.id))).map((r) => [r.id, r]))
    return hits
      .map((h) => [records.get(h.id), h.score] as const)
      .filter((pair): pair is readonly [EventRecord, number] => pair[0] !== undefined && (pair[0].expiresAt === null || parseTime(pair[0].expiresAt) > now))
      .map(([r, s]) => [r, s])
  }

  // ---- entity store index ---------------------------------------------------------------------------------------

  static entityText(entity: Entity): string {
    const label = (entity.state[LABEL] as string | undefined) || entity.key
    const values = Object.entries(entity.state).filter(([k, v]) => !k.startsWith('_') && present(v)).map(([, v]) => String(v)).join('; ')
    return label ? `${label}: ${values}` : values
  }

  private async reindex(userId: number, ids: Set<string>, calls: ModelCall[]): Promise<void> {
    const entities = await store.getEntities(userId, [...ids])
    if (entities.length === 0) return
    const texts = entities.map((e) => MemoryBase.entityText(e))
    try {
      const vectors = await this.embed(texts, 'add', calls)
      await this.qdrant.upsert(this.qdrant.entities, entities.map((e, i) => ({
        id: e.id, vector: { dense: vectors[i]! }, payload: { user_id: e.userId, session_id: e.sessionId, scope: e.scope, schema: e.schema },
      })))
      for (const [i, e] of entities.entries()) await store.setEntityText(userId, e.id, texts[i]!)
    } catch (error) {
      log('memory_index_failed', { entities: entities.length, ...errorFields(error) })
    }
  }

  /** The member's entities nearest to `query`: their lasting ones and, with `sessionId`, that chat's. */
  async searchEntities(userId: number, query: string, sessionId: string | undefined, topK: number, calls: ModelCall[]): Promise<[Entity, number][]> {
    const [vector] = await this.embed([query], 'search', calls)
    const hits = await this.qdrant.searchEntities(userId, vector!, sessionId, topK)
    const entities = new Map((await store.getEntities(userId, hits.map((h) => h.id))).map((e) => [e.id, e]))
    return hits.filter((h) => entities.has(h.id)).map((h) => [entities.get(h.id)!, h.score])
  }

  // ---- write ----------------------------------------------------------------------------------------------------

  async ingest(input: { userId: number; sessionId: string; messages: Message[]; context?: Message[]; at?: string }, calls: ModelCall[]): Promise<IngestResult> {
    const at = input.at ?? store.nowIso()
    const today = new Date(new Date(at).getTime() + 7 * 3_600_000).toISOString().slice(0, 10) // the member's day (+07:00)
    const query = input.messages.map((m) => m.content).join(' ').slice(-2000)
    const known = await this.prefetch(input.userId, input.sessionId, query, calls)
    let extraction: Extraction
    try {
      extraction = await this.extractor.extract(input.messages, known, calls, { context: input.context, today })
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // broken JSON — usually an answer cut short by a turn rich in facts: halve it (measured on LOCOMO: one such
      // error used to lose the rest of the session)
      if (input.messages.length < 2) return { ...emptyResult(), dropped: 1 }
      const half = Math.floor(input.messages.length / 2)
      const first = await this.ingest({ ...input, messages: input.messages.slice(0, half) }, calls)
      return addResult(first, await this.ingest({ ...input, messages: input.messages.slice(half), context: [...(input.context ?? []).slice(-2), ...input.messages.slice(0, half).slice(-2)] }, calls))
    }
    return this.apply(extraction, input.userId, input.sessionId, at, calls)
  }

  async apply(extraction: Extraction, userId: number, sessionId: string, at: string, calls: ModelCall[]): Promise<IngestResult> {
    const result: IngestResult = { ...emptyResult(), dropped: extraction.dropped.length, noiseMessages: extraction.noise.length, segments: extraction.segments.length }

    // 1) dedup: code first, then one model call for the near ones of the whole turn
    const keep: ExtractedEvent[] = []
    const borderline: [ExtractedEvent, EventRecord][] = []
    for (const extracted of extraction.events) {
      if (extracted.demotedFrom) result.demoted += 1
      const [verdict, nearest] = await this.duplicate(extracted, userId, sessionId, calls)
      if (verdict === 'duplicate') result.duplicates += 1
      else if (verdict === 'ask' && nearest && this.options.llmDedup) borderline.push([extracted, nearest])
      else keep.push(extracted)
    }
    if (borderline.length > 0) {
      const flags = await resolveDuplicates(this.model, borderline.map(([e, n]) => [e.content, n.content]), calls)
      borderline.forEach(([extracted], i) => (flags[i] ? (result.duplicates += 1) : keep.push(extracted)))
    }

    // 2) store the events, fold them into entities
    const day = new Date(parseTime(at).getTime() + 7 * 3_600_000) // the member's day (+07:00), as in ingest
    const anchor = utcDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())
    const touched = new Set<string>()
    for (const extracted of keep) {
      const schema = eventSchema(this.schema, extracted.type)
      if (!schema) continue
      const props: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(extracted.properties)) props[k] = typeof v === 'string' ? v.trim() : v
      // time phrases → absolute dates, in code (timeparse.ts): the model copies the phrase, this works out the day
      for (const spec of schema.properties) {
        if (spec.type === 'date' && typeof props[spec.name] === 'string' && props[spec.name]) props[spec.name] = resolveWhen(props[spec.name], anchor)
      }
      // … and a fact whose key is itself a time ("hạn nộp: thứ Sáu tuần sau" — measured with Qwen: it keeps a deadline
      // as a fact more often than in `when`)
      if (typeof props.key === 'string' && TIME_KEY.test(fold(props.key)) && typeof props.value === 'string' && props.value) props.value = resolveWhen(props.value, anchor)
      const expires = schema.ttlDays ? new Date(parseTime(at).getTime() + schema.ttlDays * 86_400_000).toISOString() : null
      const record = await this.addEvent({
        id: randomUUID(), userId, sessionId, scope: extracted.scope, type: extracted.type, content: extracted.content, props,
        importance: extracted.importance, topic: extracted.topic, ranges: extracted.ranges, source: extracted.source, keywords: extracted.keywords,
        level: 0, createdAt: at, expiresAt: expires, compressedInto: null, hits: 0, lastAccess: null,
      }, calls)
      result.eventsAdded += 1
      for (const entity of this.schema.entities) {
        const triggered = triggeredBy(entity, extracted.type)
        if (triggered.length === 0) continue
        const key = this.key(entity, props)
        let updated: Entity | undefined
        for (const prop of triggered) {
          const value = props[prop.aggregate.field]
          if ((value === undefined || value === null || value === '') && prop.aggregate.op !== 'COUNT') continue
          updated = await store.updateEntity({
            schema: entity.name, scope: entity.scope, userId, sessionId, key, prop: prop.name, op: prop.aggregate.op, value, eventId: record.id, sourceSession: sessionId, at,
          })
          result.entityUpdates += 1
        }
        if (updated && entity.key && props[entity.key]) {
          await store.updateEntity({
            schema: entity.name, scope: entity.scope, userId, sessionId, key, prop: LABEL, op: 'IMMUTABLE', value: String(props[entity.key]), eventId: record.id, sourceSession: sessionId, at,
          })
        }
        if (updated) touched.add(updated.id)
      }
    }

    // 3) text patches (EUA); not located → LLM_MERGE
    for (const patch of extraction.patches) {
      const schema = entitySchema(this.schema, patch.entity)
      if (!schema || !schema.properties.some((p) => p.name === patch.property && p.aggregate.op === 'LLM_MERGE')) {
        result.dropped += 1
        continue
      }
      const owner = schema.scope === 'session' ? sessionId : ''
      const key = schema.key ? fold(patch.key) : ''
      const current = await store.findEntity(schema.name, userId, owner, key)
      if (!current || !current.state[patch.property]) {
        const created = await store.updateEntity({ schema: schema.name, scope: schema.scope, userId, sessionId, key, prop: patch.property, op: 'LLM_MERGE', value: patch.replace, sourceSession: sessionId, at })
        touched.add(created.id)
        continue
      }
      const old = String(current.state[patch.property])
      let [text, replaced] = applyPatch(old, patch.search, patch.replace)
      if (replaced) result.patchesApplied += 1
      else if (this.options.llmMerge) {
        text = await mergeText(this.model, old, patch.replace, this.languageName, this.options.maxTextChars, calls)
        result.patchesMerged += 1
      }
      if (text.length > this.options.maxTextChars && this.options.llmMerge) text = await mergeText(this.model, text, '', this.languageName, this.options.maxTextChars, calls)
      await store.setText(userId, current.id, patch.property, text, sessionId)
      touched.add(current.id)
    }

    // 4) forget on request: the entity and the events that fed it
    for (const request of extraction.forget) {
      const schema = entitySchema(this.schema, request.entity)
      if (!schema) continue
      const owner = schema.scope === 'session' ? sessionId : ''
      const target = await store.findEntity(schema.name, userId, owner, schema.key ? fold(request.key) : '')
      if (!target) continue
      await this.drop(userId, target.id)
      touched.delete(target.id)
      result.forgotten += 1
    }

    await this.reindex(userId, touched, calls)
    return result
  }

  /** Deletes an entity and the events that fed it (so they do not come back through retrieval). */
  private async drop(userId: number, entityId: string): Promise<void> {
    const entity = await store.getEntity(userId, entityId, true)
    if (!entity) return
    await this.deleteEvents(userId, entity.history.map((h) => h.eventId).filter(Boolean))
    await store.deleteEntity(userId, entityId)
    await this.qdrant.deleteIds(this.qdrant.entities, [entityId]).catch(() => undefined)
  }

  private async duplicate(extracted: ExtractedEvent, userId: number, sessionId: string, calls: ModelCall[]): Promise<['duplicate' | 'ask' | 'new', EventRecord | undefined]> {
    // 1) keyed entity: the new value equals the current one → nothing new
    const props = extracted.properties
    for (const entity of this.schema.entities) {
      const triggered = triggeredBy(entity, extracted.type)
      if (triggered.length === 0 || !entity.key) continue
      const owner = entity.scope === 'session' ? sessionId : ''
      const current = await store.findEntity(entity.name, userId, owner, this.key(entity, props))
      if (current && triggered.filter((p) => p.aggregate.op === 'SET' || p.aggregate.op === 'IMMUTABLE')
        .every((p) => fold(String(current.state[p.name] ?? '')) === fold(String(props[p.aggregate.field] ?? '')))) {
        return ['duplicate', undefined]
      }
      if (current) return ['new', undefined] // same key, other value: an update, not a duplicate
    }
    // 2) no key: against the nearest event of the same type and scope
    const owner: Owner = extracted.scope === 'session' ? { userId, scope: 'session', sessionId } : { userId, scope: 'user' }
    for (const [record, sim] of await this.denseSearch(extracted.content, owner, 3, calls)) {
      if (record.type !== extracted.type) continue
      if (sim >= this.options.autoDuplicate) return ['duplicate', record]
      if (sim >= this.options.askDuplicate) return ['ask', record]
    }
    return ['new', undefined]
  }

  /** For the extractor: the chat's single entities + the top-K related ones (ANN on entity vectors). */
  private async prefetch(userId: number, sessionId: string, query: string, calls: ModelCall[]): Promise<Entity[]> {
    const singles = (await store.listEntities(userId, { sessionId })).filter((e) => !e.key)
    if (!query.trim()) return singles
    const related = (await this.searchEntities(userId, query, sessionId, this.options.prefetchK, calls).catch(() => [])).map(([e]) => e).filter((e) => e.key)
    return [...singles, ...related]
  }

  private key(entity: EntitySchema, props: Record<string, unknown>): string {
    return entity.key ? fold(String(props[entity.key] ?? '')).slice(0, 200) : ''
  }

  // ---- the member's own view ------------------------------------------------------------------------------------

  async memories(userId: number): Promise<MemoryItem[]> {
    const out: MemoryItem[] = []
    for (const entity of await store.listEntities(userId, {}, true)) {
      let text: string
      if (entity.key) {
        text = MemoryBase.line(entity).slice(2)
      } else {
        const values = Object.entries(entity.state).filter(([k, v]) => !k.startsWith('_') && present(v)).map(([, v]) => String(v))
        text = `${this.title(entity.schema)}: ${values.join('; ')}`
      }
      out.push({ id: entity.id, scope: entity.scope, sessionId: entity.scope === 'user' ? '' : entity.sessionId, schema: entity.schema, text, updatedAt: entity.updatedAt })
    }
    return out
  }

  /** The member's text becomes the current value (history keeps the old); the events behind the old one are dropped. */
  async edit(userId: number, entityId: string, text: string, calls: ModelCall[]): Promise<boolean> {
    const entity = await store.getEntity(userId, entityId, true)
    if (!entity) return false
    const schema = entitySchema(this.schema, entity.schema)
    if (!schema || schema.properties.length === 0) return false
    await this.deleteEvents(userId, entity.history.map((h) => h.eventId).filter(Boolean))
    await store.setText(userId, entityId, schema.properties[0]!.name, text.trim(), 'user-edit')
    await this.reindex(userId, new Set([entityId]), calls)
    return true
  }

  async forget(userId: number, entityId: string): Promise<boolean> {
    if (!(await store.getEntity(userId, entityId))) return false
    await this.drop(userId, entityId)
    return true
  }

  /**
   * Clears memories: one scope, one chat's own (`sessionId`: its session scope only — what the member said to keep
   * from now on stays), or everything. Returns the number of memories (entities) removed.
   */
  async clear(userId: number, filter: { scope?: Scope; sessionId?: string } = {}): Promise<number> {
    let removed = 0
    for (const entity of await store.listEntities(userId)) {
      if (filter.scope !== undefined && entity.scope !== filter.scope) continue
      if (filter.sessionId !== undefined && (entity.scope === 'user' || entity.sessionId !== filter.sessionId)) continue
      await this.drop(userId, entity.id)
      removed += 1
    }
    const leftover = (await store.listEvents({ userId, ...(filter.scope ? { scope: filter.scope } : {}), ...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}) }))
      .filter((r) => filter.sessionId === undefined || r.scope !== 'user')
      .map((r) => r.id)
    await this.deleteEvents(userId, leftover)
    return removed
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  /** TIME_COMPRESS + expiry with reinforcement + merging keys + repairing vectors. */
  async maintain(userId: number, calls: ModelCall[], now = new Date()): Promise<Record<string, number>> {
    const cfg = this.compress
    const live = await store.listEvents({ userId, level: 0, liveAt: now.toISOString(), uncompressed: true })
    let summaries = 0
    for (const plan of planCompression(live, cfg, now)) {
      const summary = summaryRecord(plan, await summarizeTimeline(this.model, plan, this.languageName, calls))
      if (!summary.content) continue
      await this.addEvent(summary, calls)
      await store.markCompressed(userId, plan.events.map((r) => r.id), summary.id, new Date(now.getTime() + cfg.ttlDays * 86_400_000).toISOString())
      summaries += 1
    }
    const [remove, postpone] = expiryDecisions(await store.expiredEvents(userId, now.toISOString()), cfg, now)
    await store.postponeEvents(userId, postpone, new Date(now.getTime() + cfg.ttlDays * 86_400_000).toISOString())
    const deleted = await this.deleteEvents(userId, remove)
    const merged = await this.consolidate(userId, calls)
    const repaired = await this.repair(userId, calls)
    return { summaries, postponed: postpone.length, deleted, merged, repaired }
  }

  /**
   * Merges entities with keys that mean the same thing, per scope: the member's lasting ones, and each chat's
   * (unlike pynote's server, which only merged the user scope — docs/memory-plugin-plan.md §6).
   */
  async consolidate(userId: number, calls: ModelCall[]): Promise<number> {
    let merged = 0
    const all = await store.listEntities(userId)
    for (const schema of this.schema.entities) {
      if (!schema.key) continue
      const pools = new Map<string, Entity[]>()
      for (const e of all.filter((x) => x.schema === schema.name)) pools.set(e.sessionId, [...(pools.get(e.sessionId) ?? []), e])
      for (const pool of pools.values()) {
        if (pool.length < 2) continue
        const members = pool.slice(0, 100)
        for (const group of await consolidateKeys(this.model, schema.name, members.map((e) => String(e.state[LABEL] ?? e.key)), calls)) {
          const ordered = group.map((i) => members[i]!).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          await store.mergeEntities(userId, ordered[0]!.id, ordered.slice(1).map((e) => e.id))
          await this.qdrant.deleteIds(this.qdrant.entities, ordered.slice(1).map((e) => e.id)).catch(() => undefined)
          merged += ordered.length - 1
          await this.reindex(userId, new Set([ordered[0]!.id]), calls)
        }
      }
    }
    return merged
  }

  /** Rows with no point (a failed upsert) get their vector back; points with no row are removed. */
  async repair(userId: number, calls: ModelCall[]): Promise<number> {
    const events = await store.listEvents({ userId })
    const eventPoints = new Set(await this.qdrant.ids(this.qdrant.events, userId))
    let repaired = 0
    for (const record of events.filter((r) => !eventPoints.has(r.id)).slice(0, 200)) {
      const [vector] = await this.embed([record.content], 'add', calls)
      await this.qdrant.upsert(this.qdrant.events, [{
        id: record.id, vector: { dense: vector!, terms: sparseVector(this.sparseText(record)) },
        payload: { user_id: userId, session_id: record.scope === 'session' ? record.sessionId : '', scope: record.scope, type: record.type, level: record.level },
      }])
      repaired += 1
    }
    const known = new Set(events.map((r) => r.id))
    await this.qdrant.deleteIds(this.qdrant.events, [...eventPoints].filter((id) => !known.has(id)))
    const entities = await store.listEntities(userId)
    const entityPoints = new Set(await this.qdrant.ids(this.qdrant.entities, userId))
    const missing = entities.filter((e) => !entityPoints.has(e.id)).map((e) => e.id)
    if (missing.length > 0) {
      await this.reindex(userId, new Set(missing.slice(0, 200)), calls)
      repaired += Math.min(missing.length, 200)
    }
    const knownEntities = new Set(entities.map((e) => e.id))
    await this.qdrant.deleteIds(this.qdrant.entities, [...entityPoints].filter((id) => !knownEntities.has(id)))
    return repaired
  }

  // ---- read: retrieval --------------------------------------------------------------------------------------------

  private business(record: EventRecord): number {
    const event = eventSchema(this.schema, record.type)
    return (event ? event.weight : 0.6) * record.importance // a timeline summary: a middle weight
  }

  async retrieve(query: string, userId: number, sessionId: string | undefined, calls: ModelCall[], now = new Date()): Promise<Retrieved[]> {
    const cfg = this.retrieval
    const owners: Owner[] = [...(sessionId ? [{ userId, scope: 'session' as const, sessionId }] : []), { userId, scope: 'user' as const }]
    const live = (r: EventRecord) => r.expiresAt === null || parseTime(r.expiresAt) > now

    // primary: hybrid dense + sparse, in one owner filter each
    const [vector] = await this.embed([query], 'search', calls)
    const dense = new Map<string, number>()
    const sparse = new Map<string, number>()
    const sparseQ = sparseQuery(query)
    for (const owner of owners) {
      for (const hit of await this.qdrant.searchEventsDense(owner, vector!, cfg.denseK)) dense.set(hit.id, Math.max(dense.get(hit.id) ?? 0, hit.score))
      for (const hit of await this.qdrant.searchEventsSparse(owner, sparseQ, cfg.sparseK)) sparse.set(hit.id, Math.max(sparse.get(hit.id) ?? 0, hit.score))
    }
    const records = new Map((await store.getEvents(userId, [...new Set([...dense.keys(), ...sparse.keys()])])).filter(live).map((r) => [r.id, r]))
    // dense: e5 cosines sit high (~0.8 for anything) → min–max over the candidates; sparse: divided by the best
    const denseN = minMax(new Map([...dense].filter(([id]) => records.has(id))))
    const sparseN = byMax(new Map([...sparse].filter(([id]) => records.has(id))))
    const primary: Retrieved[] = [...records.values()].map((record) => {
      const origin = cfg.alphaDense * (denseN.get(record.id) ?? 0) + (1 - cfg.alphaDense) * (sparseN.get(record.id) ?? 0)
      return { record, score: finalScore(origin, parseTime(record.createdAt), this.business(record), now, this.weights), path: 'primary' as const }
    }).sort((a, b) => b.score - a.score)
    const chosen = primary.filter((r) => r.score >= cfg.minScore).slice(0, cfg.primaryQuota)

    // secondary: the keyword graph (query → nearest keywords → the events linked to them)
    if (cfg.keywordQuota > 0) {
      const taken = new Set(chosen.map((r) => r.record.id))
      const hits = new Map<string, Retrieved>()
      for (const keyword of await this.qdrant.searchKeywords(userId, vector!, cfg.keywordTop)) {
        if (keyword.score < cfg.keywordMinSimilarity) continue
        for (const owner of owners) {
          const ids = (await store.keywordEvents(userId, String(keyword.payload.keyword ?? ''), owner, now.toISOString())).filter((id) => !taken.has(id))
          for (const record of await store.getEvents(userId, ids)) {
            const score = finalScore(keyword.score, parseTime(record.createdAt), this.business(record), now, this.weights)
            if (!hits.has(record.id) || hits.get(record.id)!.score < score) hits.set(record.id, { record, score, path: 'keyword' })
          }
        }
      }
      chosen.push(...[...hits.values()].sort((a, b) => b.score - a.score).filter((r) => r.score >= cfg.minScore).slice(0, cfg.keywordQuota))
    }

    // rerank the merged set, blended with the retrieval score
    if (chosen.length > 0 && !(this.reranker instanceof NoReranker)) {
      const scores = await this.reranker.scores(query, chosen.map((r) => r.record.content), calls).catch(() => [])
      chosen.forEach((item, i) => {
        if (scores[i] !== undefined) item.score = (1 - cfg.rerankBlend) * item.score + cfg.rerankBlend * scores[i]!
      })
    }
    chosen.sort((a, b) => b.score - a.score)
    if (cfg.reinforce) await store.touchEvents(userId, chosen.map((r) => r.record.id), now.toISOString()).catch(() => undefined)
    return chosen
  }

  // ---- read: the memory block -------------------------------------------------------------------------------------

  async context(userId: number, sessionId: string, query: string, calls: ModelCall[], now = new Date()): Promise<MemoryContext> {
    const userEntities = await this.rankEntities(await store.listEntities(userId, { scope: 'user' }, true), query, userId, undefined, this.budget.userEntities, now, calls)
    const sessionAll = await store.listEntities(userId, { sessionId }, true)
    const singles = sessionAll.filter((e) => !e.key)
    const keyed = await this.rankEntities(sessionAll.filter((e) => e.key), query, userId, sessionId, this.budget.entities, now, calls)

    const retrieved = (query.trim() ? await this.retrieve(query, userId, sessionId, calls, now) : []).filter((r) => r.score >= this.budget.minEventScore)

    // the budget covers the entities too: in order of relevance until their share is used; the rest for events
    const entityRoom = this.budget.maxTokens * CHARS_PER_TOKEN * (1 - this.budget.eventShare)
    let used = 0
    const fits = (line: string) => {
      if (used + line.length + 1 > entityRoom) return false
      used += line.length + 1
      return true
    }
    const userLines = userEntities.map((e) => MemoryBase.line(e)).filter(fits)
    const singleBlocks: [string, string][] = []
    for (const entity of singles) {
      const text = Object.entries(entity.state).filter(([k, v]) => !k.startsWith('_') && present(v)).map(([, v]) => String(v)).join('; ')
      if (text && fits(text)) singleBlocks.push([entity.schema, text])
    }
    const kept = keyed.filter((e) => fits(MemoryBase.line(e)))

    const sections: string[] = []
    if (userLines.length > 0) sections.push(`### Về người dùng (mọi cuộc chat)\n${userLines.join('\n')}`)
    for (const [schemaName, text] of singleBlocks) sections.push(`### ${this.title(schemaName)}\n${text}`)
    for (const [schemaName, title] of [['ChatFact', 'Dữ kiện hiện hành'], ['ChatDecision', 'Đã chốt'], ['ChatTask', 'Việc']] as const) {
      const rows = kept.filter((e) => e.schema === schemaName).map((e) => MemoryBase.line(e))
      if (rows.length > 0) sections.push(`### ${title}\n${rows.join('\n')}`)
    }
    for (const schemaName of [...new Set(kept.map((e) => e.schema))].filter((s) => !['ChatFact', 'ChatDecision', 'ChatTask'].includes(s)).sort()) {
      sections.push(`### ${schemaName}\n${kept.filter((e) => e.schema === schemaName).map((e) => MemoryBase.line(e)).join('\n')}`)
    }
    let fixed = sections.join('\n\n')
    const shownEntities = [...userEntities.filter((e) => userLines.includes(MemoryBase.line(e))), ...singles, ...kept]
    const shown = new Set(shownEntities.map((e) => JSON.stringify([e.schema, e.userId, e.sessionId, e.key])))

    const events = retrieved.filter((r) => !this.represented(r.record, shown))
    const header = '\n\n### Ghi nhận liên quan\n'
    let room = this.budget.maxTokens * CHARS_PER_TOKEN - fixed.length - header.length
    const lines: string[] = []
    for (const item of events) {
      const tag = item.record.level ? 'tóm tắt' : item.record.createdAt.slice(0, 10)
      let line = `- [${tag}] ${item.record.content}`
      // When it happened (the `when` property) is not the day it was noted: a small model often leaves it in the
      // property and not in the sentence, and a "khi nào" question then only sees the day noted (pynote, Qwen, LOCOMO).
      const when = String(item.record.props.when ?? '').trim()
      if (when && !fold(item.record.content).includes(fold(when))) line += ` (khi: ${when})`
      if (room - line.length < 0) break
      room -= line.length + 1
      lines.push(line)
    }
    if (lines.length > 0) fixed += (fixed ? header : header.trimStart()) + lines.join('\n')
    const text = fixed
      ? '## Bộ nhớ (hệ thống, không phải người dùng)\n' +
        'Dùng khi phù hợp. Giá trị trong "Dữ kiện hiện hành" là giá trị MỚI NHẤT; "trước:" là giá trị đã bị thay. ' +
        'Yêu cầu mới của người dùng luôn thắng bộ nhớ.\n\n' + fixed
      : ''
    return { text, tokens: Math.round(text.length / CHARS_PER_TOKEN), entities: shownEntities.length, events: lines.length }
  }

  /** Always by relevance (then recency), so what the token budget cuts is the least relevant. */
  private async rankEntities(pool: Entity[], query: string, userId: number, sessionId: string | undefined, quota: number, now: Date, calls: ModelCall[]): Promise<Entity[]> {
    if (!query.trim() || pool.length === 0) return [...pool].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, quota)
    const sims = new Map((await this.searchEntities(userId, query, sessionId, Math.max(pool.length, 1), calls).catch(() => [])).map(([e, s]) => [e.id, s]))
    return pool
      .map((e) => [finalScore(sims.get(e.id) ?? 0, parseTime(e.updatedAt), 0.5, now, this.weights), e] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, quota)
      .map(([, e]) => e)
  }

  private represented(record: EventRecord, shown: Set<string>): boolean {
    for (const entity of this.schema.entities) {
      if (triggeredBy(entity, record.type).length === 0) continue
      const owner = entity.scope === 'session' ? record.sessionId : ''
      if (shown.has(JSON.stringify([entity.name, record.userId, owner, this.key(entity, record.props)]))) return true
    }
    return false
  }

  private title(schemaName: string): string {
    if (schemaName === 'ChatBrief') return 'Mục tiêu cuộc chat'
    return entitySchema(this.schema, schemaName)?.description ?? schemaName
  }

  /**
   * One entity line, dated: the day the current value was set (SET) or each item's day (APPEND). The source event's
   * date is dropped when the entity represents it, so a missing date here loses the timeline (measured on LOCOMO:
   * "when" questions answered "unknown" with everything in the store). Ends with up to two replaced values.
   */
  static line(entity: Entity): string {
    const label = (entity.state[LABEL] as string | undefined) || entity.key || entity.schema
    const dated = new Map<string, string>()
    for (const h of entity.history) {
      if ((h.prop === 'value' || h.prop === 'decision') && h.at) {
        for (const item of Array.isArray(h.value) ? h.value : [h.value]) dated.set(fold(String(item)), h.at.slice(0, 10))
      }
    }
    const show = (value: unknown) => (Array.isArray(value)
      ? value.map((v) => (dated.has(fold(String(v))) ? `${String(v)} (${dated.get(fold(String(v)))!})` : String(v))).join('; ')
      : String(value))
    const values = Object.entries(entity.state)
      .filter(([k, v]) => !k.startsWith('_') && present(v))
      .map(([k, v]) => (k === 'value' || k === 'decision' || k === 'status' ? show(v) : `${k}: ${String(v)}`))
    const currentValue = entity.state.value ?? entity.state.decision ?? ''
    const current = fold(String(currentValue))
    const since = Array.isArray(entity.state.value) ? undefined : dated.get(current)
    let line = `- ${since ? `[${since}] ` : ''}${label}: ${values.join('; ')}`
    const previous: string[] = []
    for (const h of [...entity.history].reverse()) {
      if ((h.prop === 'value' || h.prop === 'decision') && h.op === 'SET') {
        const value = String(h.value)
        if (fold(value) !== current && previous.every((p) => !p.startsWith(value))) previous.push(h.at ? `${value} [${h.at.slice(0, 10)}]` : value)
      }
    }
    if (previous.length > 0) line += ` (trước: ${previous.slice(0, 2).join(', ')})`
    return line
  }
}
