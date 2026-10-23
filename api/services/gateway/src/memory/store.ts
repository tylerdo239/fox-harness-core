// The memory's MariaDB side (api/migrations/003_memory.sql), the source of truth; vectors are on Qdrant (qdrant.ts).
// Port of pynote-memory's catalog.py (events, keyword links) and entity_store.py (entities, history, replay).
// Every function is about one user: `userId` is a required argument wherever rows are read by owner.
import { randomUUID } from 'node:crypto'

import { dbTransaction, memoryDb, type DbRunner } from '../db.ts'
import { applyOp, type Op } from './operators.ts'
import type { Scope } from './schema.ts'
import { fold } from './text.ts'

/** ISO (code) ⇄ 'YYYY-MM-DD HH:MM:SS.mmm' UTC (MariaDB datetime(3)). */
export function toDb(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '')
}
export function fromDb(text: string | null | undefined): string | null {
  if (!text) return null
  return `${text.replace(' ', 'T')}${text.includes('.') ? '' : '.000'}Z`
}
export const nowIso = () => new Date().toISOString()

export interface EventRecord {
  id: string
  userId: number
  /** the chat it was said in (kept for user-scope events too: forgetting a chat's contribution) */
  sessionId: string
  scope: Scope
  type: string
  content: string
  props: Record<string, unknown>
  importance: number
  topic: string
  ranges: string
  source: string
  keywords: string[]
  /** 0 a detail, 1 a period summary (TIME_COMPRESS) */
  level: number
  createdAt: string
  expiresAt: string | null
  compressedInto: string | null
  hits: number
  lastAccess: string | null
}

export interface HistoryRow {
  prop: string
  op: string
  value: unknown
  eventId: string
  session: string
  at: string
}

export interface Entity {
  id: string
  schema: string
  scope: Scope
  userId: number
  sessionId: string
  key: string
  state: Record<string, unknown>
  text: string
  updatedAt: string
  history: HistoryRow[]
}

type EventRow = {
  event_id: string; user_id: number; session_id: string; scope: Scope; type: string; content: string; props: string | Record<string, unknown>
  importance: number; topic: string; ranges: string; source: string; keywords: string | string[]; level: number; created_at: string
  expires_at: string | null; compressed_into: string | null; hits: number; last_access: string | null
}

const json = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function eventFrom(row: EventRow): EventRecord {
  return {
    id: row.event_id, userId: Number(row.user_id), sessionId: row.session_id, scope: row.scope, type: row.type, content: row.content,
    props: json(row.props, {}), importance: Number(row.importance), topic: row.topic, ranges: row.ranges, source: row.source,
    keywords: json(row.keywords, []), level: Number(row.level), createdAt: fromDb(row.created_at)!, expiresAt: fromDb(row.expires_at),
    compressedInto: row.compressed_into, hits: Number(row.hits), lastAccess: fromDb(row.last_access),
  }
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',')

// ---- events -------------------------------------------------------------------------------------------------------

export async function insertEvent(record: EventRecord, db: DbRunner = memoryDb): Promise<void> {
  await db.query(
    `insert into discovery_memory_events (event_id, user_id, session_id, scope, type, content, props, importance, topic, ranges, source,
       keywords, level, compressed_into, hits, last_access, expires_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, null, ?, ?)`,
    [record.id, record.userId, record.sessionId, record.scope, record.type, record.content.slice(0, 1000), JSON.stringify(record.props),
      record.importance, record.topic.slice(0, 200), record.ranges.slice(0, 200), record.source.slice(0, 1500), JSON.stringify(record.keywords),
      record.level, record.compressedInto, record.expiresAt ? toDb(record.expiresAt) : null, toDb(record.createdAt)],
  )
}

export async function getEvents(userId: number, ids: string[]): Promise<EventRecord[]> {
  if (ids.length === 0) return []
  const rows = await memoryDb.query<EventRow[]>(`select * from discovery_memory_events where user_id = ? and event_id in (${marks(ids.length)})`, [userId, ...ids])
  const byId = new Map(rows.map((r) => [r.event_id, eventFrom(r)]))
  return ids.map((id) => byId.get(id)).filter((r): r is EventRecord => r !== undefined)
}

export async function listEvents(filter: { userId: number; sessionId?: string; scope?: Scope; level?: number; liveAt?: string; uncompressed?: boolean }): Promise<EventRecord[]> {
  let sql = 'select * from discovery_memory_events where user_id = ?'
  const args: unknown[] = [filter.userId]
  if (filter.scope) { sql += ' and scope = ?'; args.push(filter.scope) }
  if (filter.sessionId !== undefined) { sql += ' and session_id = ?'; args.push(filter.sessionId) }
  if (filter.level !== undefined) { sql += ' and level = ?'; args.push(filter.level) }
  if (filter.liveAt) { sql += ' and (expires_at is null or expires_at > ?)'; args.push(toDb(filter.liveAt)) }
  if (filter.uncompressed) sql += ' and compressed_into is null'
  return (await memoryDb.query<EventRow[]>(`${sql} order by created_at`, args)).map(eventFrom)
}

export async function expiredEvents(userId: number, now: string): Promise<EventRecord[]> {
  return (await memoryDb.query<EventRow[]>(
    'select * from discovery_memory_events where user_id = ? and expires_at is not null and expires_at <= ?', [userId, toDb(now)])).map(eventFrom)
}

export async function touchEvents(userId: number, ids: string[], at: string): Promise<void> {
  if (ids.length === 0) return
  await memoryDb.query(`update discovery_memory_events set hits = hits + 1, last_access = ? where user_id = ? and event_id in (${marks(ids.length)})`, [toDb(at), userId, ...ids])
}

export async function markCompressed(userId: number, ids: string[], summaryId: string, expiresAt: string): Promise<void> {
  if (ids.length === 0) return
  await memoryDb.query(`update discovery_memory_events set compressed_into = ?, expires_at = ? where user_id = ? and event_id in (${marks(ids.length)})`,
    [summaryId, toDb(expiresAt), userId, ...ids])
}

export async function postponeEvents(userId: number, ids: string[], expiresAt: string): Promise<void> {
  if (ids.length === 0) return
  await memoryDb.query(`update discovery_memory_events set expires_at = ? where user_id = ? and event_id in (${marks(ids.length)})`, [toDb(expiresAt), userId, ...ids])
}

/** Deletes events and their keyword links; returns the deleted ids and the keywords no event carries any more. */
export async function deleteEvents(userId: number, ids: string[]): Promise<{ ids: string[]; orphanKeywords: string[] }> {
  if (ids.length === 0) return { ids: [], orphanKeywords: [] }
  return dbTransaction(async (db) => {
    const found = (await db.query<{ event_id: string }[]>(`select event_id from discovery_memory_events where user_id = ? and event_id in (${marks(ids.length)})`, [userId, ...ids]))
      .map((r) => r.event_id)
    if (found.length === 0) return { ids: [], orphanKeywords: [] }
    const keywords = (await db.query<{ keyword: string }[]>(
      `select distinct keyword from discovery_memory_keyword_links where user_id = ? and event_id in (${marks(found.length)})`, [userId, ...found])).map((r) => r.keyword)
    await db.query(`delete from discovery_memory_events where user_id = ? and event_id in (${marks(found.length)})`, [userId, ...found])
    await db.query(`delete from discovery_memory_keyword_links where user_id = ? and event_id in (${marks(found.length)})`, [userId, ...found])
    const still = keywords.length === 0 ? [] : (await db.query<{ keyword: string }[]>(
      `select distinct keyword from discovery_memory_keyword_links where user_id = ? and keyword in (${marks(keywords.length)})`, [userId, ...keywords])).map((r) => r.keyword)
    return { ids: found, orphanKeywords: keywords.filter((k) => !still.includes(k)) }
  })
}

export async function sessionEventIds(userId: number, sessionId: string, scope?: Scope): Promise<string[]> {
  return (await memoryDb.query<{ event_id: string }[]>(
    `select event_id from discovery_memory_events where user_id = ? and session_id = ?${scope ? ' and scope = ?' : ''}`, scope ? [userId, sessionId, scope] : [userId, sessionId]))
    .map((r) => r.event_id)
}

// ---- keyword graph ------------------------------------------------------------------------------------------------

export async function linkKeywords(userId: number, eventId: string, keywords: string[]): Promise<string[]> {
  const folded = [...new Set(keywords.map((k) => fold(k).slice(0, 100)).filter(Boolean))]
  for (const keyword of folded) {
    await memoryDb.query('insert ignore into discovery_memory_keyword_links (user_id, keyword, event_id) values (?, ?, ?)', [userId, keyword, eventId])
  }
  return folded
}

/** Live events of `owner` carrying `keyword`. */
export async function keywordEvents(userId: number, keyword: string, owner: { scope: Scope; sessionId?: string }, now: string): Promise<string[]> {
  const scopeSql = owner.scope === 'session' ? "e.scope = 'session' and e.session_id = ?" : "e.scope = 'user'"
  const rows = await memoryDb.query<{ event_id: string }[]>(
    `select e.event_id from discovery_memory_keyword_links l join discovery_memory_events e on e.event_id = l.event_id
     where l.user_id = ? and l.keyword = ? and e.user_id = ? and ${scopeSql} and (e.expires_at is null or e.expires_at > ?)`,
    owner.scope === 'session' ? [userId, keyword, userId, owner.sessionId ?? '', toDb(now)] : [userId, keyword, userId, toDb(now)],
  )
  return rows.map((r) => r.event_id)
}

// ---- entities -----------------------------------------------------------------------------------------------------

type EntityRow = { entity_id: string; schema_name: string; scope: Scope; user_id: number; session_id: string; entity_key: string; state: string | Record<string, unknown>; aux: string | Record<string, unknown>; text: string; updated_at: string }
type HistoryDbRow = { entity_id: string; prop: string; op: string; value: string; event_id: string; source_session: string; at: string }

async function withHistory(db: DbRunner, entities: Entity[]): Promise<Entity[]> {
  if (entities.length === 0) return entities
  const rows = await db.query<HistoryDbRow[]>(
    `select entity_id, prop, op, value, event_id, source_session, at from discovery_memory_entity_history where entity_id in (${marks(entities.length)}) order by id`,
    entities.map((e) => e.id))
  const byEntity = new Map<string, HistoryRow[]>()
  for (const r of rows) {
    const list = byEntity.get(r.entity_id) ?? []
    list.push({ prop: r.prop, op: r.op, value: json(r.value, r.value), eventId: r.event_id, session: r.source_session, at: fromDb(r.at)! })
    byEntity.set(r.entity_id, list)
  }
  for (const e of entities) e.history = byEntity.get(e.id) ?? []
  return entities
}

function entityFrom(row: EntityRow): Entity {
  return {
    id: row.entity_id, schema: row.schema_name, scope: row.scope, userId: Number(row.user_id), sessionId: row.session_id, key: row.entity_key,
    state: json(row.state, {}), text: row.text, updatedAt: fromDb(row.updated_at)!, history: [],
  }
}

export async function getEntities(userId: number, ids: string[], history = false): Promise<Entity[]> {
  if (ids.length === 0) return []
  const rows = await memoryDb.query<EntityRow[]>(`select * from discovery_memory_entities where user_id = ? and entity_id in (${marks(ids.length)})`, [userId, ...ids])
  const entities = rows.map(entityFrom)
  return history ? withHistory(memoryDb, entities) : entities
}

export async function getEntity(userId: number, id: string, history = false): Promise<Entity | undefined> {
  return (await getEntities(userId, [id], history))[0]
}

export async function findEntity(schema: string, userId: number, ownerSession: string, key: string): Promise<Entity | undefined> {
  const rows = await memoryDb.query<EntityRow[]>(
    'select * from discovery_memory_entities where schema_name = ? and user_id = ? and session_id = ? and entity_key = ?', [schema, userId, ownerSession, key])
  return rows[0] ? entityFrom(rows[0]) : undefined
}

/** The member's entities: the lasting ones (`scope: 'user'`), one chat's (`sessionId`), or all. Newest first. */
export async function listEntities(userId: number, filter: { sessionId?: string; scope?: Scope } = {}, history = false): Promise<Entity[]> {
  let sql = 'select * from discovery_memory_entities where user_id = ?'
  const args: unknown[] = [userId]
  if (filter.scope === 'user') sql += " and scope = 'user'"
  else if (filter.sessionId !== undefined) { sql += ' and session_id = ?'; args.push(filter.sessionId) }
  const entities = (await memoryDb.query<EntityRow[]>(`${sql} order by updated_at desc`, args)).map(entityFrom)
  return history ? withHistory(memoryDb, entities) : entities
}

/** Folds `value` into `prop` of the entity (created when missing), in one transaction with its history row. */
export async function updateEntity(input: {
  schema: string; scope: Scope; userId: number; sessionId: string; key: string; prop: string; op: Op; value: unknown; eventId?: string; sourceSession?: string; at: string
}): Promise<Entity> {
  const ownerSession = input.scope === 'session' ? input.sessionId : ''
  return dbTransaction(async (db) => {
    const rows = await db.query<EntityRow[]>(
      'select * from discovery_memory_entities where schema_name = ? and user_id = ? and session_id = ? and entity_key = ? for update',
      [input.schema, input.userId, ownerSession, input.key])
    let id: string
    let state: Record<string, unknown>
    let aux: Record<string, Record<string, unknown>>
    if (rows[0]) {
      id = rows[0].entity_id
      state = json(rows[0].state, {})
      aux = json(rows[0].aux, {})
    } else {
      id = randomUUID()
      state = {}
      aux = {}
      await db.query(
        `insert into discovery_memory_entities (entity_id, schema_name, scope, user_id, session_id, entity_key, state, aux, text, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, '{}', '{}', '', ?, ?)`,
        [id, input.schema, input.scope, input.userId, ownerSession, input.key.slice(0, 200), toDb(input.at), toDb(input.at)])
    }
    const [value, nextAux] = applyOp(input.op, state[input.prop], aux[input.prop] ?? {}, input.value)
    state[input.prop] = value
    aux[input.prop] = nextAux
    await db.query('update discovery_memory_entities set state = ?, aux = ?, updated_at = ? where entity_id = ?', [JSON.stringify(state), JSON.stringify(aux), toDb(input.at), id])
    await db.query(
      'insert into discovery_memory_entity_history (entity_id, prop, op, value, event_id, source_session, at) values (?, ?, ?, ?, ?, ?, ?)',
      [id, input.prop, input.op, JSON.stringify(input.value), input.eventId ?? '', input.sourceSession ?? input.sessionId, toDb(input.at)])
    return { id, schema: input.schema, scope: input.scope, userId: input.userId, sessionId: ownerSession, key: input.key, state, text: '', updatedAt: input.at, history: [] }
  })
}

/** The result of a text patch (LLM_MERGE) or a member's edit: the whole new text, kept in history as TEXT. */
export async function setText(userId: number, entityId: string, prop: string, text: string, sourceSession: string, eventId = ''): Promise<void> {
  const at = nowIso()
  await dbTransaction(async (db) => {
    const rows = await db.query<EntityRow[]>('select * from discovery_memory_entities where user_id = ? and entity_id = ? for update', [userId, entityId])
    if (!rows[0]) return
    const state = json<Record<string, unknown>>(rows[0].state, {})
    state[prop] = text
    await db.query('update discovery_memory_entities set state = ?, updated_at = ? where entity_id = ?', [JSON.stringify(state), toDb(at), entityId])
    await db.query('insert into discovery_memory_entity_history (entity_id, prop, op, value, event_id, source_session, at) values (?, ?, ?, ?, ?, ?, ?)',
      [entityId, prop, 'TEXT', JSON.stringify(text), eventId, sourceSession, toDb(at)])
  })
}

export async function setEntityText(userId: number, entityId: string, text: string): Promise<void> {
  await memoryDb.query('update discovery_memory_entities set text = ? where user_id = ? and entity_id = ?', [text.slice(0, 2000), userId, entityId])
}

export async function deleteEntity(userId: number, entityId: string): Promise<boolean> {
  return dbTransaction(async (db) => {
    const result = await db.query<{ affectedRows: number }>('delete from discovery_memory_entities where user_id = ? and entity_id = ?', [userId, entityId])
    if (result.affectedRows > 0) await db.query('delete from discovery_memory_entity_history where entity_id = ?', [entityId])
    return result.affectedRows > 0
  })
}

/** Recomputes an entity's state from its history (after merging or forgetting a chat's contribution); deletes it when no history is left. */
async function replay(db: DbRunner, entityId: string, order: 'id' | 'at, id' = 'id'): Promise<boolean> {
  const rows = await db.query<HistoryDbRow[]>(`select prop, op, value from discovery_memory_entity_history where entity_id = ? order by ${order}`, [entityId])
  if (rows.length === 0) {
    await db.query('delete from discovery_memory_entities where entity_id = ?', [entityId])
    return false
  }
  const state: Record<string, unknown> = {}
  const aux: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    const value = json<unknown>(row.value, row.value)
    if (row.op === 'TEXT') {
      state[row.prop] = value
      continue
    }
    const [next, nextAux] = applyOp(row.op as Op, state[row.prop], aux[row.prop] ?? {}, value)
    state[row.prop] = next
    aux[row.prop] = nextAux
  }
  await db.query('update discovery_memory_entities set state = ?, aux = ? where entity_id = ?', [JSON.stringify(state), JSON.stringify(aux), entityId])
  return true
}

/** Merges entities that mean the same thing into `targetId`: their history moves over and is replayed in time order. */
export async function mergeEntities(userId: number, targetId: string, sourceIds: string[]): Promise<void> {
  const sources = sourceIds.filter((id) => id !== targetId)
  if (sources.length === 0) return
  await dbTransaction(async (db) => {
    const owned = (await db.query<{ entity_id: string }[]>(
      `select entity_id from discovery_memory_entities where user_id = ? and entity_id in (${marks(sources.length + 1)})`, [userId, targetId, ...sources])).map((r) => r.entity_id)
    if (!owned.includes(targetId)) return
    const mine = sources.filter((id) => owned.includes(id))
    if (mine.length === 0) return
    await db.query(`update discovery_memory_entity_history set entity_id = ? where entity_id in (${marks(mine.length)})`, [targetId, ...mine])
    await db.query(`delete from discovery_memory_entities where entity_id in (${marks(mine.length)})`, mine)
    await replay(db, targetId, 'at, id')
  })
}

/** Deletes a chat's entities and its contribution to the lasting ones (replayed). Returns the entity ids touched. */
export async function forgetSessionEntities(userId: number, sessionId: string): Promise<{ removed: string[]; replayed: string[] }> {
  return dbTransaction(async (db) => {
    const own = (await db.query<{ entity_id: string }[]>('select entity_id from discovery_memory_entities where user_id = ? and session_id = ?', [userId, sessionId])).map((r) => r.entity_id)
    if (own.length > 0) {
      await db.query(`delete from discovery_memory_entity_history where entity_id in (${marks(own.length)})`, own)
      await db.query(`delete from discovery_memory_entities where entity_id in (${marks(own.length)})`, own)
    }
    const touched = (await db.query<{ entity_id: string }[]>(
      `select distinct h.entity_id from discovery_memory_entity_history h join discovery_memory_entities e on e.entity_id = h.entity_id
       where e.user_id = ? and h.source_session = ?`, [userId, sessionId])).map((r) => r.entity_id)
    const removed = [...own]
    const replayed: string[] = []
    for (const id of touched) {
      await db.query('delete from discovery_memory_entity_history where entity_id = ? and source_session = ?', [id, sessionId])
      if (await replay(db, id)) replayed.push(id)
      else removed.push(id)
    }
    return { removed, replayed }
  })
}

// ---- switches -----------------------------------------------------------------------------------------------------

export async function getSwitch(owner: string): Promise<boolean | undefined> {
  const rows = await memoryDb.query<{ enabled: number }[]>('select enabled from discovery_memory_settings where owner = ?', [owner])
  return rows[0] === undefined ? undefined : Boolean(rows[0].enabled)
}

export async function setSwitch(owner: string, enabled: boolean): Promise<void> {
  await memoryDb.query(
    'insert into discovery_memory_settings (owner, enabled) values (?, ?) on duplicate key update enabled = values(enabled), updated_at = current_timestamp',
    [owner, enabled ? 1 : 0])
}

export async function deleteSwitch(owner: string): Promise<void> {
  await memoryDb.query('delete from discovery_memory_settings where owner = ?', [owner])
}
