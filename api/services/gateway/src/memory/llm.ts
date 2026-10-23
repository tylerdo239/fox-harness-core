// The memory's model calls (port of pynote-memory's llm.py, embedder.py, rerank.py): an OpenAI-compatible chat call
// that returns one JSON object, the embedding client (e5 prefixes, a cache), and the rerankers. Every call is
// recorded in the `calls` list it is given, for discovery_usage_steps (docs/memory-plugin-plan.md §7).
import { config } from '../config.ts'

export interface ModelCall {
  purpose: string
  model: string
  in: number
  out: number
  cacheRead?: number
  ms: number
  ok: boolean
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatModel {
  completeJson(messages: ChatMessage[], purpose: string, calls: ModelCall[]): Promise<Record<string, unknown>>
}

export interface Embedder {
  readonly dims: number
  embed(texts: string[], action: 'add' | 'search', calls: ModelCall[]): Promise<number[][]>
}

export interface Reranker {
  scores(query: string, documents: string[], calls: ModelCall[]): Promise<number[]>
}

/** The first JSON object in a model's answer (small models wrap it in ```json fences or add a sentence). */
export function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new SyntaxError('no JSON object in the answer')
  const value = JSON.parse(body.slice(start, end + 1)) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('the answer is not a JSON object')
  return value as Record<string, unknown>
}

function extraBody(): Record<string, unknown> {
  if (!config.memory.llmExtraBody) return {}
  try {
    const value = JSON.parse(config.memory.llmExtraBody) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function postJson(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw Object.assign(new Error(`HTTP ${String(res.status)}: ${text.slice(0, 300)}`), { status: res.status })
  return JSON.parse(text) as Record<string, unknown>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** One retry on a timeout, a network error or a 429/5xx (pynote's retry.py, shortened). */
async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status !== undefined && status !== 429 && status < 500) throw error
    await sleep(1000)
    return work()
  }
}

export class OpenAICompatModel implements ChatModel {
  private jsonMode = true

  constructor(
    private readonly baseUrl = config.memory.llmBaseUrl,
    private readonly apiKey = config.memory.llmApiKey,
    readonly model = config.memory.llmModel,
  ) {}

  async completeJson(messages: ChatMessage[], purpose: string, calls: ModelCall[]): Promise<Record<string, unknown>> {
    const started = Date.now()
    const body: Record<string, unknown> = { model: this.model, messages, temperature: 0, max_tokens: 4000, stream: false, ...extraBody() }
    let recorded = false
    try {
      let answer: Record<string, unknown>
      try {
        answer = await withRetry(() => postJson(`${this.baseUrl}/chat/completions`, this.apiKey, this.jsonMode ? { ...body, response_format: { type: 'json_object' } } : body, 120_000))
      } catch (error) {
        // a server without response_format support: once, then never again for this process
        if (!this.jsonMode || !String(error).includes('response_format')) throw error
        this.jsonMode = false
        answer = await withRetry(() => postJson(`${this.baseUrl}/chat/completions`, this.apiKey, body, 120_000))
      }
      const usage = answer.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined
      calls.push({
        purpose, model: this.model, in: usage?.prompt_tokens ?? 0, out: usage?.completion_tokens ?? 0,
        ...(usage?.prompt_tokens_details?.cached_tokens === undefined ? {} : { cacheRead: usage.prompt_tokens_details.cached_tokens }),
        ms: Date.now() - started, ok: true,
      })
      recorded = true
      const choice = (answer.choices as { message?: { content?: string } }[] | undefined)?.[0]
      return parseJsonObject(choice?.message?.content ?? '')
    } catch (error) {
      // a call that answered but whose answer did not parse is already recorded (its tokens were spent)
      if (!recorded) calls.push({ purpose, model: this.model, in: 0, out: 0, ms: Date.now() - started, ok: false })
      throw error
    }
  }
}

/** A small LRU cache of embeddings: the same text is embedded once (an event's content, then its keywords' link). */
class Cache {
  private readonly map = new Map<string, number[]>()
  constructor(private readonly max = 2000) {}
  get(key: string): number[] | undefined {
    const hit = this.map.get(key)
    if (hit) {
      this.map.delete(key)
      this.map.set(key, hit)
    }
    return hit
  }
  set(key: string, value: number[]): void {
    this.map.set(key, value)
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }
}

export class OpenAICompatEmbedder implements Embedder {
  private readonly cache = new Cache()
  private readonly prefixes: boolean
  dims = 0

  constructor(
    private readonly baseUrl = config.memory.embedBaseUrl,
    private readonly apiKey = config.memory.embedApiKey,
    readonly model = config.memory.embedModel,
    prefixes = config.memory.embedPrefix,
  ) {
    this.prefixes = prefixes ?? /e5/i.test(model)
  }

  async embed(texts: string[], action: 'add' | 'search', calls: ModelCall[]): Promise<number[][]> {
    // e5: "query: " to search, "passage: " to store
    const prepared = texts.map((t) => (this.prefixes ? `${action === 'search' ? 'query: ' : 'passage: '}${t}` : t).slice(0, 8000))
    const out: (number[] | undefined)[] = prepared.map((p) => this.cache.get(p))
    const missing = prepared.map((p, i) => (out[i] ? -1 : i)).filter((i) => i >= 0)
    if (missing.length > 0) {
      const started = Date.now()
      try {
        // no `dimensions` parameter: e5 servers reject it
        const answer = await withRetry(() => postJson(`${this.baseUrl}/embeddings`, this.apiKey, { model: this.model, input: missing.map((i) => prepared[i]) }, 30_000))
        const data = (answer.data as { index?: number; embedding: number[] }[] | undefined) ?? []
        data.forEach((item, n) => {
          const i = missing[item.index ?? n]!
          out[i] = item.embedding
          this.cache.set(prepared[i]!, item.embedding)
        })
        const usage = answer.usage as { prompt_tokens?: number; total_tokens?: number } | undefined
        calls.push({ purpose: 'memory-embed', model: this.model, in: usage?.prompt_tokens ?? usage?.total_tokens ?? 0, out: 0, ms: Date.now() - started, ok: true })
      } catch (error) {
        calls.push({ purpose: 'memory-embed', model: this.model, in: 0, out: 0, ms: Date.now() - started, ok: false })
        throw error
      }
    }
    const vectors = out.map((v) => {
      if (!v) throw new Error('the embedding server returned fewer vectors than asked')
      return v
    })
    if (this.dims === 0 && vectors[0]) this.dims = vectors[0].length
    return vectors
  }
}

export class NoReranker implements Reranker {
  async scores(): Promise<number[]> {
    return []
  }
}

/** A /rerank endpoint (bge-reranker-v2-m3 and the like): {results: [{index, relevance_score}]}. */
export class HttpReranker implements Reranker {
  constructor(private readonly baseUrl = config.memory.rerankBaseUrl, private readonly apiKey = config.memory.rerankApiKey, readonly model = config.memory.rerankModel) {}

  async scores(query: string, documents: string[], calls: ModelCall[]): Promise<number[]> {
    if (documents.length === 0) return []
    const started = Date.now()
    const answer = await withRetry(() => postJson(`${this.baseUrl}/rerank`, this.apiKey, { model: this.model, query, documents }, 30_000))
    const out = documents.map(() => 0)
    for (const item of (answer.results as { index: number; relevance_score?: number; score?: number }[] | undefined) ?? []) {
      if (item.index >= 0 && item.index < out.length) out[item.index] = Math.min(1, Math.max(0, Number(item.relevance_score ?? item.score ?? 0)))
    }
    calls.push({ purpose: 'memory-rerank', model: this.model, in: 0, out: 0, ms: Date.now() - started, ok: true })
    return out
  }
}

export class LLMReranker implements Reranker {
  constructor(private readonly model: ChatModel) {}

  async scores(query: string, documents: string[], calls: ModelCall[]): Promise<number[]> {
    if (documents.length === 0) return []
    const listing = documents.map((doc, i) => `[${String(i)}] ${doc.slice(0, 400)}`).join('\n')
    const answer = await this.model.completeJson([
      { role: 'system', content: 'Chấm mức hữu ích của từng ghi nhớ để trả lời câu hỏi, từ 0 (không liên quan) đến 1 (trả lời trực tiếp). Chỉ trả JSON: {"scores": [số theo đúng thứ tự ghi nhớ]}.' },
      { role: 'user', content: `Câu hỏi: ${query}\n\nGhi nhớ:\n${listing}` },
    ], 'memory-rerank', calls)
    const raw = Array.isArray(answer.scores) ? answer.scores : []
    return documents.map((_, i) => {
      const value = Number(raw[i])
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
    })
  }
}
