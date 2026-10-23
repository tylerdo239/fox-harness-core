// MemoryBase on a real MariaDB (003_memory.sql applied) and a real Qdrant, with a scripted model and a hashing
// embedder (pynote-memory's ScriptedModel / HashEmbedder). Ported from pynote's test_core / test_paper / test_product.
//   DATABASE_URL=mariadb://fox_harness:fox_harness_dev@127.0.0.1:3307/discovery-agent QDRANT_URL=http://127.0.0.1:6333 \
//   MEMORY_COLLECTION_PREFIX=test_ node --experimental-transform-types --test --test-force-exit services/gateway/test/memory.integration.test.ts
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'

import { MemoryBase } from '../src/memory/core.ts'
import type { ChatMessage, ChatModel, Embedder, ModelCall } from '../src/memory/llm.ts'
import { Qdrant } from '../src/memory/qdrant.ts'
import { SCHEMA } from '../src/memory/schema.ts'
import * as store from '../src/memory/store.ts'
import { fold, terms } from '../src/memory/text.ts'

class ScriptedModel implements ChatModel {
  readonly prompts: [string, ChatMessage[]][] = []
  private readonly answers = new Map<string, Record<string, unknown>[]>()
  constructor(answers: Record<string, Record<string, unknown> | Record<string, unknown>[]>) {
    for (const [purpose, value] of Object.entries(answers)) this.answers.set(`memory-${purpose}`, Array.isArray(value) ? [...value] : [value])
  }
  async completeJson(messages: ChatMessage[], purpose: string, calls: ModelCall[]): Promise<Record<string, unknown>> {
    this.prompts.push([purpose, messages])
    calls.push({ purpose, model: 'scripted', in: 10, out: 5, ms: 1, ok: true })
    return this.answers.get(purpose)?.shift() ?? {}
  }
  count(purpose: string): number {
    return this.prompts.filter(([p]) => p === `memory-${purpose}`).length
  }
}

/** Bag of folded words hashed into 64 dims: the same words → cosine 1, shared words → close. */
class HashEmbedder implements Embedder {
  readonly dims = 64
  async embed(texts: string[], _action: 'add' | 'search', calls: ModelCall[]): Promise<number[][]> {
    calls.push({ purpose: 'memory-embed', model: 'hash', in: texts.length, out: 0, ms: 0, ok: true })
    return texts.map((text) => {
      const v = new Array<number>(this.dims).fill(0)
      for (const term of terms(text)) {
        let h = 0
        for (const ch of term) h = (h * 31 + ch.charCodeAt(0)) >>> 0
        v[h % this.dims]! += 1
      }
      const norm = Math.hypot(...v) || 1
      return v.map((x) => x / norm)
    })
  }
}

const qdrant = new Qdrant(process.env.QDRANT_URL ?? 'http://127.0.0.1:6333', '', 'test_')
const users: number[] = []
const newUser = () => {
  const id = 900_000_000 + Math.floor(Math.random() * 99_999_999)
  users.push(id)
  return id
}
const chat = () => randomUUID()
const build = (answers: Record<string, Record<string, unknown> | Record<string, unknown>[]>) => {
  const model = new ScriptedModel(answers)
  return { model, memory: new MemoryBase(SCHEMA, model, new HashEmbedder(), qdrant) }
}
const fact = (key: string, value: string, note?: string) => ({ type: 'fact', properties: { key, value, ...(note ? { note } : {}) }, content: `${key}: ${value}`, importance: 0.8 })
const pref = (aspect: string, value: string) => ({ type: 'preference', properties: { aspect, value }, content: `${aspect}: ${value}`, importance: 0.7 })
const U = [{ role: 'user' as const, content: 'nội dung' }]
const calls: ModelCall[] = []

after(async () => {
  const { memory } = build({})
  for (const id of users) {
    await memory.clear(id)
    for (const c of [qdrant.events, qdrant.entities, qdrant.keywords]) await qdrant.deleteOwned(c, id).catch(() => undefined)
  }
})

test('a corrected figure: the newest value with its history, no stale event beside it', async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: [{ events: [fact('Ngân sách dự án', '800 triệu đồng')] }, { events: [fact('ngân sách dự án', '500 triệu đồng', 'ban giám đốc cắt từ 800 triệu')] }] })
  await memory.ingest({ userId: user, sessionId: s, messages: [{ role: 'user', content: 'Ngân sách năm nay 800 triệu' }] }, calls)
  await memory.ingest({ userId: user, sessionId: s, messages: [{ role: 'user', content: 'BGĐ cắt còn 500 triệu' }] }, calls)
  const facts = (await store.listEntities(user, { sessionId: s })).filter((e) => e.schema === 'ChatFact')
  assert.equal(facts.length, 1)
  assert.equal(facts[0]!.state.value, '500 triệu đồng')
  const { text } = await memory.context(user, s, 'ngân sách', calls)
  assert.ok(text.includes('Ngân sách dự án: 500 triệu đồng'), text)
  assert.ok(text.includes('(trước: 800 triệu đồng ['), text)
  assert.ok(!text.includes('Ghi nhận liên quan'), text)
})

test("a project's numbers never reach the user scope; the member's role does, in every chat", async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: { events: [
    pref('ngân sách', '500 triệu'),
    { type: 'profile', properties: { aspect: 'đội drone', value: '6 chiếc, bình 20 lít' }, content: 'y', importance: 0.8 },
    { type: 'profile', properties: { aspect: 'vai trò', value: 'trưởng nhóm kỹ thuật' }, content: 'z', importance: 0.6 },
  ] } })
  const result = await memory.ingest({ userId: user, sessionId: s, messages: [{ role: 'user', content: 'Bạn ghi nhớ giúp tôi nhé' }] }, calls)
  assert.equal(result.demoted, 2)
  assert.deepEqual((await store.listEntities(user, { scope: 'user' })).map((e) => e.state.value), ['trưởng nhóm kỹ thuật'])
  const other = (await memory.context(user, chat(), 'ngân sách', calls)).text
  assert.ok(other.includes('trưởng nhóm kỹ thuật'), other)
  assert.ok(!other.includes('500') && !other.includes('20 lít'), other)
})

test('a lasting preference reaches a new chat; clearing a chat keeps it', async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: { events: [pref('đơn vị tiền', 'tỷ đồng'), fact('số drone', '6 chiếc')] } })
  await memory.ingest({ userId: user, sessionId: s, messages: [{ role: 'user', content: 'Từ nay mọi báo cáo dùng đơn vị tỷ đồng, đội có 6 drone' }] }, calls)
  assert.ok((await memory.context(user, chat(), 'đơn vị tiền', calls)).text.includes('tỷ đồng'))
  await memory.clear(user, { sessionId: s })
  assert.deepEqual((await store.listEntities(user, { sessionId: s })), [])
  assert.deepEqual((await store.listEntities(user, { scope: 'user' })).map((e) => e.state.value), ['tỷ đồng'])
})

test('a duplicate fact is skipped', async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: [{ events: [fact('số drone', '6 chiếc')] }, { events: [fact('Số drone', '6 chiếc')] }] })
  await memory.ingest({ userId: user, sessionId: s, messages: [{ role: 'user', content: '6 drone' }] }, calls)
  const second = await memory.ingest({ userId: user, sessionId: s, messages: [{ role: 'user', content: 'nhắc lại: 6 drone' }] }, calls)
  assert.equal(second.duplicates, 1)
  assert.equal(second.eventsAdded, 0)
})

test('a near duplicate without a key is settled by one model call', async () => {
  const user = newUser()
  const s = chat()
  const { memory, model } = build({ extract: [{ events: [{ type: 'task', properties: { task: 'báo cáo hoàn vốn quý 3', status: 'open' }, content: 'Lập báo cáo hoàn vốn quý 3 cho ban giám đốc' }] },
    { events: [{ type: 'task', properties: { task: 'báo cáo hoàn vốn quý ba', status: 'open' }, content: 'Lập báo cáo hoàn vốn quý 3 cho ban giám đốc ngay' }] }], dedup: { duplicate: [true] } })
  await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  const second = await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  assert.equal(model.count('dedup'), 1)
  assert.equal(second.duplicates, 1)
})

test('forget on request removes the entity and the events that fed it', async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: [{ events: [fact('mã dự án', 'UAV-77X')] }, { events: [], forget: [{ entity: 'ChatFact', key: 'mã dự án' }] }] })
  await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  const result = await memory.ingest({ userId: user, sessionId: s, messages: [{ role: 'user', content: 'quên mã dự án đi' }] }, calls)
  assert.equal(result.forgotten, 1)
  assert.deepEqual(await store.listEntities(user, { sessionId: s }), [])
  assert.deepEqual(await store.listEvents({ userId: user }), [])
})

test('the keyword branch finds an exact code (sparse IDF)', async () => {
  const user = newUser()
  const s = chat()
  const events = [
    { type: 'decision', properties: { topic: 'thiết bị', decision: 'dùng bộ điều khiển UAV-77X cho đội bay' }, content: 'Chốt dùng bộ điều khiển UAV-77X cho đội bay', keywords: ['UAV-77X', 'bộ điều khiển'] },
    { type: 'decision', properties: { topic: 'nhân sự', decision: 'thuê thêm hai phi công' }, content: 'Chốt thuê thêm hai phi công', keywords: ['phi công'] },
  ]
  const { memory } = build({ extract: { events } })
  await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  const found = await memory.retrieve('UAV-77X', user, s, calls)
  assert.ok(found.length > 0 && found[0]!.record.content.includes('UAV-77X'), JSON.stringify(found.map((f) => f.record.content)))
})

test('patch in place without a model call; LLM_MERGE when it cannot locate', async () => {
  const user = newUser()
  const s = chat()
  const { memory, model } = build({
    extract: [
      { events: [{ type: 'goal', properties: { summary: 'Mua 6 drone cho 3 xã. Ngân sách 800 triệu.' }, content: 'mục tiêu' }] },
      { events: [], patches: [{ entity: 'ChatBrief', key: '', property: 'summary', search: 'Ngân sách 800 triệu.', replace: 'Ngân sách 500 triệu.' }] },
      { events: [], patches: [{ entity: 'ChatBrief', key: '', property: 'summary', search: 'câu không hề có', replace: 'Thêm báo cáo hoàn vốn.' }] },
    ],
    merge: { text: 'Mua 6 drone cho 3 xã. Ngân sách 500 triệu. Thêm báo cáo hoàn vốn.' },
  })
  await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  const second = await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  assert.equal(second.patchesApplied, 1)
  const brief = () => store.listEntities(user, { sessionId: s }).then((list) => list.find((e) => e.schema === 'ChatBrief')!.state.summary)
  assert.equal(await brief(), 'Mua 6 drone cho 3 xã. Ngân sách 500 triệu.')
  const third = await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  assert.equal(third.patchesMerged, 1)
  assert.equal(model.count('merge'), 1)
  assert.ok(String(await brief()).includes('báo cáo hoàn vốn'))
})

test("the member's view: list both scopes, edit drops the old events, forget, clear everything", async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: { events: [pref('đơn vị tiền', 'triệu đồng'), fact('ngân sách', '800 triệu')] } })
  await memory.ingest({ userId: user, sessionId: s, messages: [{ role: 'user', content: 'từ nay dùng triệu đồng; ngân sách 800 triệu' }] }, calls)
  const items = await memory.memories(user)
  assert.deepEqual(items.map((m) => m.scope).sort(), ['session', 'user'])
  const budget = items.find((m) => m.schema === 'ChatFact')!
  assert.ok(await memory.edit(user, budget.id, '450 triệu đồng', calls))
  assert.equal((await store.getEntity(user, budget.id))!.state.value, '450 triệu đồng')
  assert.equal((await store.listEvents({ userId: user, sessionId: s, scope: 'session' })).length, 0)
  const text = (await memory.context(user, s, 'ngân sách', calls)).text
  // as pynote: the edit is the current value; the old one stays only as history ("trước:"), never as an event
  assert.ok(text.includes('ngân sách: 450 triệu đồng'), text)
  assert.ok(!text.includes('Ghi nhận liên quan'), text)
  assert.ok((await store.listEvents({ userId: user })).every((e) => !e.content.includes('800')))
  assert.ok(await memory.forget(user, items.find((m) => m.scope === 'user')!.id))
  assert.equal(await memory.clear(user), 1)
  assert.deepEqual(await memory.memories(user), [])
})

test('isolation: another member sees, edits and deletes nothing', async () => {
  const a = newUser()
  const b = newUser()
  const s = chat()
  const { memory } = build({ extract: { events: [pref('đơn vị tiền', 'tỷ đồng'), fact('ngân sách bí mật', '999 tỷ')] } })
  await memory.ingest({ userId: a, sessionId: s, messages: [{ role: 'user', content: 'từ nay dùng tỷ đồng; ngân sách bí mật 999 tỷ' }] }, calls)
  const theirs = await memory.memories(a)
  assert.equal(theirs.length, 2)
  assert.deepEqual(await memory.memories(b), [])
  for (const id of theirs.map((m) => m.id)) {
    assert.equal(await memory.edit(b, id, 'x', calls), false)
    assert.equal(await memory.forget(b, id), false)
  }
  const seen = (await memory.context(b, s, 'ngân sách bí mật tỷ đồng', calls)).text
  assert.equal(seen, '')
  assert.equal((await memory.retrieve('ngân sách bí mật', b, s, calls)).length, 0)
  assert.equal(await memory.clear(b), 0)
  assert.equal((await memory.memories(a)).length, 2)
})

test('clearing a chat removes its Qdrant points too', async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: { events: [fact('số xã', '3 xã'), fact('số drone', '6 chiếc')] } })
  await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  assert.ok((await qdrant.ids(qdrant.events, user)).length >= 2)
  await memory.clear(user, { sessionId: s })
  assert.deepEqual(await qdrant.ids(qdrant.events, user), [])
  assert.deepEqual(await qdrant.ids(qdrant.entities, user), [])
})

test('maintain: an idle old timeline becomes one summary, its details expire unless reinforced', async () => {
  const user = newUser()
  const s = chat()
  const old = (day: number) => ({ type: 'decision', properties: { topic: `hạng mục ${String(day)}`, decision: `chốt hạng mục ${String(day)}` }, content: `Chốt hạng mục ${String(day)}` })
  const { memory, model } = build({
    extract: [{ events: [old(1)], segments: [] }, { events: [old(2)] }, { events: [old(3)] }],
    compress: { summary: 'Tuần đó chốt ba hạng mục 1, 2, 3.', keywords: ['hạng mục'], importance: 0.8 },
  })
  for (const day of [1, 2, 3]) {
    await memory.ingest({ userId: user, sessionId: s, messages: U, at: `2026-09-0${String(day)}T09:00:00.000Z` }, calls)
  }
  // one timeline: no segment topic, so the three share the type's ("decision")
  const now = new Date('2026-10-23T00:00:00Z')
  const result = await memory.maintain(user, calls, now)
  assert.ok(result.summaries! >= 1, JSON.stringify(result))
  assert.ok(model.count('compress') >= 1)
  const summaries = await store.listEvents({ userId: user, level: 1 })
  assert.ok(summaries.length >= 1 && summaries[0]!.content.includes('ba hạng mục'))
  const later = new Date(now.getTime() + 40 * 86_400_000)
  const expired = await memory.maintain(user, calls, later)
  assert.ok(expired.deleted! >= 3, JSON.stringify(expired))
})

test('consolidate merges keys that mean the same thing (chat scope too)', async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: { events: [fact('ngân sách', '500 triệu'), fact('ngân sách dự án', '500 triệu đồng')] }, keys: { groups: [[0, 1]] } })
  await memory.ingest({ userId: user, sessionId: s, messages: U }, calls)
  assert.equal(await memory.consolidate(user, calls), 1)
  const facts = (await store.listEntities(user, { sessionId: s })).filter((e) => e.schema === 'ChatFact')
  assert.equal(facts.length, 1)
})

test('the token budget holds and keeps the most relevant', async () => {
  const user = newUser()
  const s = chat()
  const events = [...Array.from({ length: 30 }, (_, i) => fact(`thiết bị ${String(i)}`, `loại ${'y'.repeat(150)}`)), fact('ngân sách dự án', '500 triệu đồng')]
  const { memory } = build({ extract: { events } })
  const small = new MemoryBase(SCHEMA, (memory as unknown as { model: ChatModel }).model, new HashEmbedder(), qdrant, undefined, 'vi', { maxTokens: 300, entities: 30, userEntities: 12, minEventScore: 0.25, eventShare: 0.3 })
  await small.ingest({ userId: user, sessionId: s, messages: U }, calls)
  const ctx = await small.context(user, s, 'ngân sách dự án', calls)
  assert.ok(ctx.tokens <= 300 + 60, String(ctx.tokens))
  assert.ok(ctx.text.includes('500 triệu đồng'), ctx.text)
  void fold
})

test('time phrases become dates in code, from the day of the conversation', async () => {
  const user = newUser()
  const s = chat()
  const { memory } = build({ extract: { events: [
    fact('hạn nộp', 'thứ Sáu tuần sau'),
    { type: 'task', properties: { task: 'nộp phương án', status: 'open', when: 'thứ Sáu tuần sau (01/01/2020)' }, content: 'Nộp phương án', importance: 0.6 },
    { type: 'fact', properties: { key: 'khảo sát', value: 'xong', when: 'hôm qua' }, content: 'Khảo sát đã xong', importance: 0.5 },
  ] } })
  // 23/10/2026 09:00 in Hà Nội is a Friday
  await memory.ingest({ userId: user, sessionId: s, messages: U, at: '2026-10-23T02:00:00.000Z' }, calls)
  const entities = await store.listEntities(user, { sessionId: s })
  assert.equal(entities.find((e) => e.key === 'han nop')?.state.value, 'thứ Sáu tuần sau (30/10/2026)')
  assert.equal(entities.find((e) => e.schema === 'ChatTask')?.state['hạn'], 'thứ Sáu tuần sau (30/10/2026)') // the model's own date is redone
  const { text } = await memory.context(user, s, 'khảo sát xong khi nào', calls)
  assert.ok(text.includes('nộp phương án: open; hạn: thứ Sáu tuần sau (30/10/2026)') || text.includes('hạn: thứ Sáu tuần sau (30/10/2026)'), text)
})
