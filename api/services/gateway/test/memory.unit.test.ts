// Unit tests of the memory's pure parts (ported from pynote-memory's offline tests where they apply).
//   node --experimental-transform-types --test services/gateway/test/memory.unit.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Extractor } from '../src/memory/extract.ts'
import { DEFAULT_COMPRESS, expiryDecisions, periodKey, planCompression } from '../src/memory/lifecycle.ts'
import { parseJsonObject, type ChatModel, type ModelCall } from '../src/memory/llm.ts'
import { applyOp, toNumber } from '../src/memory/operators.ts'
import { applyPatch, similarity } from '../src/memory/patch.ts'
import { finalScore, timeScore } from '../src/memory/rank.ts'
import { SCHEMA, validateSchema, type MemorySchema } from '../src/memory/schema.ts'
import type { EventRecord } from '../src/memory/store.ts'
import { fold, formatRanges, parseRanges, sparseQuery, sparseVector, terms } from '../src/memory/text.ts'
import { resolveWhen, utcDate } from '../src/memory/timeparse.ts'

const noModel: ChatModel = { completeJson: async () => ({}) }

test('operators: SET, IMMUTABLE, COUNT, APPEND, SUM, AVG, MAX/MIN, numbers in vi and en', () => {
  assert.equal(applyOp('SET', '800', {}, '500')[0], '500')
  assert.equal(applyOp('SET', '800', {}, '')[0], '800')
  assert.equal(applyOp('IMMUTABLE', 'a', {}, 'b')[0], 'a')
  assert.equal(applyOp('COUNT', 2, {}, 'x')[0], 3)
  assert.deepEqual(applyOp('APPEND', ['a'], {}, ['a', 'b'])[0], ['a', 'b'])
  assert.equal(applyOp('SUM', 1, {}, '1.234,5')[0], 1235.5)
  let [avg, aux] = applyOp('AVG', undefined, {}, 2)
  ;[avg, aux] = applyOp('AVG', avg, aux, 4)
  assert.equal(avg, 3)
  assert.equal(applyOp('MAX', 3, {}, '7')[0], 7)
  assert.equal(applyOp('MIN', 3, {}, '7')[0], 3)
  assert.equal(applyOp('SUM', 5, {}, 'không phải số')[0], 5)
  assert.equal(toNumber('1,234.5'), 1234.5)
  assert.equal(toNumber('1.234'), 1234)
  assert.equal(toNumber('2,5'), 2.5)
})

test('patch: exact, fuzzy (marks and punctuation), append when not found', () => {
  const old = 'Mục tiêu: mua 6 drone cho 3 xã. Ngân sách 800 triệu.'
  assert.deepEqual(applyPatch(old, 'Ngân sách 800 triệu.', 'Ngân sách 500 triệu.'), ['Mục tiêu: mua 6 drone cho 3 xã. Ngân sách 500 triệu.', true])
  const [fuzzy, located] = applyPatch(old, 'Ngan sach 800 trieu', 'Ngân sách 500 triệu')
  assert.ok(located && fuzzy.includes('500 triệu') && !fuzzy.includes('800'))
  const [appended, found] = applyPatch(old, 'điều không có trong ghi chú này cả', 'Thêm: báo cáo hoàn vốn')
  assert.ok(!found && appended.endsWith('Thêm: báo cáo hoàn vốn'))
  assert.equal(applyPatch('', '', 'mới')[0], 'mới')
})

test('patch: two identical places do not get a blind exact replace', () => {
  const [text] = applyPatch('A. B. A.', 'A.', 'C.')
  assert.equal(text.split('C.').length - 1, 1)
})

test('similarity matches difflib ratio on simple cases', () => {
  assert.equal(similarity('abcd', 'abcd'), 1)
  assert.equal(similarity('abcd', 'bcde'), 0.75)
  assert.equal(similarity('', ''), 1)
})

test('ranges, fold and terms', () => {
  assert.deepEqual(parseRanges('0-3, 7, x, 5-4', 6), [0, 1, 2, 3])
  assert.equal(formatRanges([7, 0, 1, 2, 3]), '0-3,7')
  assert.equal(fold('  Ngân  Sách Đội '), 'ngan sach doi')
  // two-letter Vietnamese syllables stay searchable (the reason for Qdrant sparse, not MariaDB FULLTEXT)
  assert.deepEqual(terms('Xã Bộ số 3, mã UAV-20'), ['xa', 'bo', 'so', '3', 'ma', 'uav', '20'])
  const sparse = sparseVector('xã xã bộ')
  assert.equal(sparse.indices.length, 2)
  assert.deepEqual([...sparse.values].sort(), [1, 2])
  assert.equal(sparseQuery('xã xã').values.length, 1)
})

test('schema: an entity is never fed by events of the other scope', () => {
  validateSchema(SCHEMA)
  const bad: MemorySchema = structuredClone(SCHEMA)
  bad.entities.find((e) => e.name === 'UserPreference')!.properties[0]!.aggregate.event = 'fact'
  assert.throws(() => validateSchema(bad))
})

test('extraction prompt: the fixed part is first and stable (prefix cache)', () => {
  const extractor = new Extractor(SCHEMA, noModel)
  const a = extractor.messages([{ role: 'user', content: 'một' }], 0, [], '2026-10-23')
  const b = extractor.messages([{ role: 'user', content: 'hai' }], 0, [], '2026-10-24')
  assert.equal(a[0]!.content, b[0]!.content)
  assert.ok(a[0]!.content.includes('Fox Harness AI Agent'))
  assert.ok(a[1]!.content.startsWith('Hôm nay: 2026-10-23'))
})

test('validation: segments, noise, sources, dropped events', () => {
  const extractor = new Extractor(SCHEMA, noModel)
  const numbered = [
    { role: 'user' as const, content: 'ngữ cảnh cũ' },
    { role: 'user' as const, content: 'chào bạn' },
    { role: 'user' as const, content: 'ngân sách 500 triệu' },
  ]
  const out = extractor.validate({
    segments: [{ id: 0, topic: 'ngân sách', ranges: '0,2' }, { id: 1, topic: 'cũ', ranges: '0' }],
    events: [
      { type: 'fact', segment: 0, properties: { key: 'ngân sách', value: '500 triệu' }, content: 'Ngân sách 500 triệu', keywords: ['ngân sách'], importance: 2 },
      { type: 'unknown' },
      { type: 'fact', properties: { key: 'x' } },
    ],
  }, numbered, 1)
  assert.equal(out.segments.length, 1) // a segment with no new message is ignored
  assert.deepEqual(out.noise, [1])
  assert.equal(out.events.length, 1)
  assert.equal(out.events[0]!.importance, 1)
  assert.equal(out.events[0]!.ranges, '0,2')
  assert.ok(out.events[0]!.source.includes('[2] user: ngân sách 500 triệu'))
  assert.equal(out.dropped.length, 2)
})

test('scope guard: project numbers never reach the user scope; a lasting preference does', () => {
  const extractor = new Extractor(SCHEMA, noModel)
  const raw = {
    events: [
      { type: 'preference', properties: { aspect: 'ngân sách', value: '500 triệu' }, content: 'x' },
      { type: 'profile', properties: { aspect: 'đội drone', value: '6 chiếc, bình 20 lít' }, content: 'y' },
      { type: 'profile', properties: { aspect: 'vai trò', value: 'trưởng nhóm kỹ thuật' }, content: 'z' },
    ],
  }
  const plain = extractor.validate(raw, [{ role: 'user', content: 'Bạn ghi nhớ giúp tôi nhé' }], 0)
  assert.deepEqual(plain.events.map((e) => [e.type, e.scope]), [['decision', 'session'], ['decision', 'session'], ['profile', 'user']])
  const lasting = extractor.validate({ events: [raw.events[0]!] }, [{ role: 'user', content: 'Từ nay mọi báo cáo dùng đơn vị tỷ đồng' }], 0)
  assert.equal(lasting.events[0]!.scope, 'user')
  const chatOnly = extractor.validate({ events: [raw.events[0]!] }, [{ role: 'user', content: 'Từ nay nhưng chỉ trong chat này thôi' }], 0)
  assert.equal(chatOnly.events[0]!.scope, 'session')
})

test('parseJsonObject tolerates fences and chatter', () => {
  assert.deepEqual(parseJsonObject('Đây:\n```json\n{"a": 1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonObject('ok {"b": [1]} xong'), { b: [1] })
  assert.throws(() => parseJsonObject('không có'), SyntaxError)
})

const event = (createdAt: string, topic: string, extra: Partial<EventRecord> = {}): EventRecord => ({
  id: `${topic}-${createdAt}`, userId: 1, sessionId: 's', scope: 'session', type: 'fact', content: topic, props: {}, importance: 0.5, topic,
  ranges: '', source: '', keywords: [], level: 0, createdAt, expiresAt: null, compressedInto: null, hits: 0, lastAccess: null, ...extra,
})

test('TIME_COMPRESS plan: lazy (idle timelines only), per period, at least 3 events', () => {
  const now = new Date('2026-10-23T00:00:00Z')
  const old = ['2026-10-05', '2026-10-06', '2026-10-07'].map((d) => event(`${d}T09:00:00.000Z`, 'ngân sách'))
  const active = [...['2026-10-05', '2026-10-06', '2026-10-07'].map((d) => event(`${d}T09:00:00.000Z`, 'drone')), event('2026-10-22T09:00:00.000Z', 'drone')]
  const plans = planCompression([...old, ...active, event('2026-10-05T09:00:00.000Z', 'lẻ')], DEFAULT_COMPRESS, now)
  assert.equal(plans.length, 1)
  assert.equal(plans[0]!.events.length, 3)
  assert.equal(plans[0]!.timeline[2], 'ngan sach')
  assert.equal(periodKey(new Date('2026-10-05T09:00:00Z'), 'week'), '2026-W41')
  assert.equal(periodKey(new Date('2026-01-01T00:00:00Z'), 'week'), '2026-W01')
})

test('expiry: deleted unless retrieved within the reinforcement window', () => {
  const now = new Date('2026-10-23T00:00:00Z')
  const [remove, postpone] = expiryDecisions([
    event('2026-09-01T00:00:00.000Z', 'a', { id: 'old' }),
    event('2026-09-01T00:00:00.000Z', 'b', { id: 'used', lastAccess: '2026-10-20T00:00:00.000Z' }),
  ], DEFAULT_COMPRESS, now)
  assert.deepEqual(remove, ['old'])
  assert.deepEqual(postpone, ['used'])
})

test('ranking: fresh for a day, then halving every 30 days; business weight breaks ties', () => {
  const now = new Date('2026-10-23T00:00:00Z')
  assert.equal(timeScore(new Date('2026-10-22T12:00:00Z'), now), 1)
  assert.ok(Math.abs(timeScore(new Date('2026-09-22T00:00:00Z'), now) - 0.5) < 0.01)
  assert.ok(finalScore(0.5, now, 0.9, now) > finalScore(0.5, now, 0.1, now))
})

test('model calls are recorded with their purpose', async () => {
  const calls: ModelCall[] = []
  const model: ChatModel = { completeJson: async (_m, purpose, c) => { c.push({ purpose, model: 'x', in: 1, out: 1, ms: 1, ok: true }); return {} } }
  await new Extractor(SCHEMA, model).extract([{ role: 'user', content: 'hi' }], [], calls)
  assert.deepEqual(calls.map((c) => c.purpose), ['memory-extract'])
})

test('timeparse: the cases pynote measured (LOCOMO and Vietnamese)', () => {
  const cases: [string, [number, number, number], string][] = [
  ['last Friday', [2023, 7, 15], 'last Friday (14 July 2023)'],
  ['yesterday', [2023, 8, 25], 'yesterday (24 August 2023)'],
  ['yesterday (19 August 2023)', [2023, 8, 25], 'yesterday (24 August 2023)'],
  ['two weekends ago', [2023, 7, 17], 'two weekends ago (8–9 July 2023)'],
  ['last weekend', [2023, 7, 17], 'last weekend (15–16 July 2023)'],
  ['last week', [2023, 6, 9], 'last week (2–8 June 2023)'],
  ['last year', [2023, 5, 8], 'last year (2022)'],
  ['last month', [2023, 1, 10], 'last month (December 2022)'],
  ['3 days ago', [2023, 3, 1], '3 days ago (26 February 2023)'],
  ['next month', [2023, 12, 5], 'next month (January 2024)'],
  ['next Tuesday', [2023, 7, 15], 'next Tuesday (18 July 2023)'],
  ['recently', [2023, 8, 17], 'recently (before 17 August 2023)'],
  ['hôm qua', [2026, 10, 23], 'hôm qua (22/10/2026)'],
  ['tuần trước', [2023, 6, 9], 'tuần trước (02/06–08/06/2023)'],
  ['thứ Sáu tuần trước', [2026, 10, 23], 'thứ Sáu tuần trước (16/10/2026)'],
  ['năm ngoái', [2026, 10, 23], 'năm ngoái (năm 2025)'],
  ['2 tháng trước', [2026, 1, 15], '2 tháng trước (tháng 11/2025)'],
  ['hai tuần trước', [2026, 10, 23], 'hai tuần trước (05/10–11/10/2026)'],
  ['thứ Hai tuần sau', [2026, 10, 23], 'thứ Hai tuần sau (26/10/2026)'],
  ]
  for (const [phrase, [y, m, d], expected] of cases) assert.equal(resolveWhen(phrase, utcDate(y, m, d)), expected, phrase)
  for (const phrase of ['5 July 2023', 'in 2022', 'the week before 9 June 2023', 'sometime', '15/07']) assert.equal(resolveWhen(phrase, utcDate(2023, 7, 15)), phrase)
})

test('assistant-only segments are not remembered; an accepted figure from the previous answer is', () => {
  const extractor = new Extractor(SCHEMA, noModel)
  const numbered = [
    { role: 'assistant' as const, content: 'Chi phí ước tính 545.280.000 VNĐ.' }, // previous answer (context)
    { role: 'user' as const, content: 'Ok, dùng con số đó, giờ làm báo cáo' },
    { role: 'assistant' as const, content: 'Đã xong báo cáo. Bạn cung cấp tên 3 xã nhé?' },
  ]
  const out = extractor.validate({
    segments: [{ id: 0, topic: 'chi phí', ranges: '0-1' }, { id: 1, topic: 'xã', ranges: '2' }],
    events: [
      { type: 'fact', segment: 0, properties: { key: 'chi phí', value: '545.280.000 VNĐ', note: 'kết quả tính' }, content: 'Chi phí 545.280.000 VNĐ' },
      { type: 'task', segment: 1, properties: { task: 'cung cấp tên 3 xã', status: 'open' }, content: 'Cung cấp tên 3 xã' },
    ],
  }, numbered, 1)
  assert.deepEqual(out.events.map((e) => e.type), ['fact'])
  assert.ok(out.dropped[0]!.includes('chỉ từ lời trợ lý'))
})

test('extraction prompt: times copied as said, assistant words are context only', () => {
  const prompt = new Extractor(SCHEMA, noModel).systemPrompt('tiếng Việt')
  assert.ok(prompt.includes('KHÔNG tự quy đổi'))
  assert.ok(prompt.includes('9. Tin của Trợ lý chỉ để hiểu ngữ cảnh'))
  assert.ok(prompt.includes('when (date'))
})
