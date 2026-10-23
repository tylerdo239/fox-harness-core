// The memory's vectors on Qdrant (docs/memory-plugin-plan.md §5.2), over its REST API (no client library).
//   <prefix>memory_events    one point per event: `dense` (embedding) + `terms` (sparse, IDF — the keyword branch)
//   <prefix>memory_entities  one point per entity: `dense`
//   <prefix>memory_keywords  one point per (user, keyword): `dense` = mean of the vectors of the events carrying it
// Point ids are the MariaDB ids (event_id / entity_id) or a uuid derived from (user, keyword).
//
// Isolation: every read takes the user id as a required argument and builds the filter itself; there is no search
// across users here (docs/memory-plugin-plan.md §12.1).
import { createHash } from 'node:crypto'

import { config } from '../config.ts'

export type SparseVector = { indices: number[]; values: number[] }

export interface Hit {
  id: string
  score: number
  payload: Record<string, unknown>
}

/** Who a search is for. `sessionId` + scope 'session': one chat's memories; scope 'user': the member's lasting ones. */
export type Owner = { userId: number; scope: 'session'; sessionId: string } | { userId: number; scope: 'user' }

export class QdrantError extends Error {}

export class Qdrant {
  private ready: Promise<void> | undefined

  constructor(
    private readonly url = config.memory.qdrantUrl,
    private readonly apiKey = config.memory.qdrantApiKey,
    private readonly prefix = config.memory.collectionPrefix,
  ) {}

  get events(): string { return `${this.prefix}memory_events` }
  get entities(): string { return `${this.prefix}memory_entities` }
  get keywords(): string { return `${this.prefix}memory_keywords` }

  private async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    if (!this.url) throw new QdrantError('QDRANT_URL is not set')
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { 'api-key': this.apiKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw Object.assign(new QdrantError(`qdrant ${method} ${path}: HTTP ${String(res.status)} ${text.slice(0, 300)}`), { status: res.status })
    return (text ? JSON.parse(text) : {}) as T
  }

  /** Creates the three collections and their payload indexes when missing (`dims` from the embedding model). */
  ensure(dims: number): Promise<void> {
    this.ready ??= this.create(dims).catch((error: unknown) => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  private async create(dims: number): Promise<void> {
    const version = await this.request<{ version?: string }>('GET', '/').then((r) => r.version ?? '', () => '')
    const [major, minor] = version.split('.').map(Number)
    if (version && (major! < 1 || (major === 1 && minor! < 10))) {
      // sparse IDF (the keyword branch) needs 1.10 (docs/memory-plugin-plan.md M1)
      throw new QdrantError(`Qdrant ${version} is too old: the memory needs >= 1.10`)
    }
    const specs: [string, Record<string, unknown>, Record<string, string>][] = [
      [this.events, { vectors: { dense: { size: dims, distance: 'Cosine' } }, sparse_vectors: { terms: { modifier: 'idf' } } },
        { user_id: 'integer', session_id: 'keyword', scope: 'keyword', type: 'keyword' }],
      [this.entities, { vectors: { dense: { size: dims, distance: 'Cosine' } } }, { user_id: 'integer', session_id: 'keyword', scope: 'keyword' }],
      [this.keywords, { vectors: { dense: { size: dims, distance: 'Cosine' } } }, { user_id: 'integer' }],
    ]
    for (const [name, spec, indexes] of specs) {
      const exists = await this.request('GET', `/collections/${name}`).then(() => true, (error: { status?: number }) => {
        if (error.status === 404) return false
        throw error
      })
      if (!exists) {
        await this.request('PUT', `/collections/${name}`, spec).catch((error: { status?: number }) => {
          if (error.status !== 409) throw error // created meanwhile by another call
        })
      }
      for (const [field, schema] of Object.entries(indexes)) {
        await this.request('PUT', `/collections/${name}/index?wait=true`, { field_name: field, field_schema: schema })
      }
    }
  }

  // ---- write ---------------------------------------------------------------------------------------------------

  async upsert(collection: string, points: { id: string; vector: Record<string, number[] | SparseVector>; payload: Record<string, unknown> }[]): Promise<void> {
    if (points.length === 0) return
    await this.request('PUT', `/collections/${collection}/points?wait=true`, { points })
  }

  async deleteIds(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.request('POST', `/collections/${collection}/points/delete?wait=true`, { points: ids })
  }

  /** Deletes a user's points, all of them or one chat's (the chat's session-scope points). */
  async deleteOwned(collection: string, userId: number, sessionId?: string): Promise<void> {
    const must: Record<string, unknown>[] = [{ key: 'user_id', match: { value: userId } }]
    if (sessionId !== undefined) must.push({ key: 'session_id', match: { value: sessionId } }, { key: 'scope', match: { value: 'session' } })
    await this.request('POST', `/collections/${collection}/points/delete?wait=true`, { filter: { must } })
  }

  async vectors(collection: string, ids: string[]): Promise<Map<string, { dense: number[]; payload: Record<string, unknown> }>> {
    const out = new Map<string, { dense: number[]; payload: Record<string, unknown> }>()
    if (ids.length === 0) return out
    const answer = await this.request<{ result: { id: string; vector?: { dense?: number[] }; payload?: Record<string, unknown> }[] }>(
      'POST', `/collections/${collection}/points`, { ids, with_vector: ['dense'], with_payload: true })
    for (const point of answer.result) if (point.vector?.dense) out.set(String(point.id), { dense: point.vector.dense, payload: point.payload ?? {} })
    return out
  }

  // ---- read (always one user's) ---------------------------------------------------------------------------------

  private ownerFilter(owner: Owner): Record<string, unknown> {
    const must: Record<string, unknown>[] = [{ key: 'user_id', match: { value: owner.userId } }, { key: 'scope', match: { value: owner.scope } }]
    if (owner.scope === 'session') must.push({ key: 'session_id', match: { value: owner.sessionId } })
    return { must }
  }

  private async query(collection: string, body: Record<string, unknown>): Promise<Hit[]> {
    const answer = await this.request<{ result: { points: { id: string; score: number; payload?: Record<string, unknown> }[] } }>(
      'POST', `/collections/${collection}/points/query`, { ...body, with_payload: true })
    return answer.result.points.map((p) => ({ id: String(p.id), score: p.score, payload: p.payload ?? {} }))
  }

  /** Events of `owner` nearest to `vector` (cosine). */
  searchEventsDense(owner: Owner, vector: number[], limit: number): Promise<Hit[]> {
    return this.query(this.events, { query: vector, using: 'dense', filter: this.ownerFilter(owner), limit })
  }

  /** Events of `owner` matching the query's terms (sparse with IDF: a BM25-like score). */
  searchEventsSparse(owner: Owner, sparse: SparseVector, limit: number): Promise<Hit[]> {
    if (sparse.indices.length === 0) return Promise.resolve([])
    return this.query(this.events, { query: sparse, using: 'terms', filter: this.ownerFilter(owner), limit })
  }

  /** The member's entities nearest to `vector`: the lasting ones and, with `sessionId`, that chat's. */
  searchEntities(userId: number, vector: number[], sessionId: string | undefined, limit: number): Promise<Hit[]> {
    const should: Record<string, unknown>[] = [{ key: 'scope', match: { value: 'user' } }]
    if (sessionId !== undefined) should.push({ key: 'session_id', match: { value: sessionId } })
    return this.query(this.entities, { query: vector, using: 'dense', filter: { must: [{ key: 'user_id', match: { value: userId } }], should }, limit })
  }

  /** The member's keywords nearest to `vector`. */
  searchKeywords(userId: number, vector: number[], limit: number): Promise<Hit[]> {
    return this.query(this.keywords, { query: vector, using: 'dense', filter: { must: [{ key: 'user_id', match: { value: userId } }] }, limit })
  }

  /** Every point id of a collection (the repair sweep compares them with MariaDB). */
  async ids(collection: string, userId: number): Promise<string[]> {
    const out: string[] = []
    let offset: unknown
    do {
      const answer = await this.request<{ result: { points: { id: string }[]; next_page_offset?: unknown } }>(
        'POST', `/collections/${collection}/points/scroll`,
        { filter: { must: [{ key: 'user_id', match: { value: userId } }] }, limit: 1000, with_payload: false, with_vector: false, ...(offset === undefined ? {} : { offset }) })
      out.push(...answer.result.points.map((p) => String(p.id)))
      offset = answer.result.next_page_offset ?? undefined
    } while (offset !== undefined && offset !== null)
    return out
  }
}

/** A stable uuid for (user, keyword): the keyword's point id. */
export function keywordPointId(userId: number, keyword: string): string {
  const hex = createHash('sha1').update(`${String(userId)}\u0000${keyword}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}
