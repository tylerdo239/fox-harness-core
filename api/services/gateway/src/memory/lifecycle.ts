// The memory's lifecycle with the model (VikingMem §3.2; port of pynote-memory's lifecycle.py, prompts verbatim):
// - TIME_COMPRESS: events grouped per topic timeline; only idle, old enough timelines are compressed ("lazy"), one
//   level-1 summary per week (or month); the detail events get a TTL.
// - expiry: compressed details past their TTL are deleted unless retrieved recently (the timeline is "reinforced").
// - mergeText: the real LLM_MERGE — old text + new part when a patch did not locate, or shortening a text too long.
// - resolveDuplicates: near-duplicate events settled with one call per turn.
// - consolidateKeys: entities with different keys that mean the same thing ("ngân sách" / "ngân sách dự án").
import { randomUUID } from 'node:crypto'

import type { ChatModel, ModelCall } from './llm.ts'
import { parseTime } from './rank.ts'
import type { EventRecord } from './store.ts'
import { fold } from './text.ts'

export const SUMMARY_TYPE = 'summary'

export interface CompressConfig {
  /** events older than this are compressed */
  windowDays: number
  /** a timeline with no new event for this long is idle */
  inactiveDays: number
  /** fewer than this is not worth a summary */
  minEvents: number
  period: 'week' | 'month'
  /** how long a compressed detail event lives */
  ttlDays: number
  /** retrieved within this many days → its expiry is postponed */
  reinforceDays: number
}

export const DEFAULT_COMPRESS: CompressConfig = { windowDays: 7, inactiveDays: 3, minEvents: 3, period: 'week', ttlDays: 30, reinforceDays: 14 }

export function timelineKey(record: EventRecord): string {
  const topic = fold(record.topic) || fold(record.type)
  return JSON.stringify([record.scope, record.scope === 'session' ? record.sessionId : '', topic])
}

/** ISO week ("2026-W43") or month ("2026-10") of a date (UTC). */
export function periodKey(created: Date, period: 'week' | 'month'): string {
  if (period === 'month') return created.toISOString().slice(0, 7)
  const day = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate()))
  const weekday = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - weekday)
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${String(day.getUTCFullYear())}-W${String(week).padStart(2, '0')}`
}

export interface CompressPlan {
  timeline: [string, string, string]
  period: string
  events: EventRecord[]
}

/** Which groups to compress. Pure, no model — tested. */
export function planCompression(events: EventRecord[], config: CompressConfig, now: Date): CompressPlan[] {
  const timelines = new Map<string, EventRecord[]>()
  for (const record of events) {
    if (record.level === 0 && record.compressedInto === null) {
      const key = timelineKey(record)
      timelines.set(key, [...(timelines.get(key) ?? []), record])
    }
  }
  const plans: CompressPlan[] = []
  for (const [key, items] of timelines) {
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const newest = parseTime(items[items.length - 1]!.createdAt)
    if (now.getTime() - newest.getTime() < config.inactiveDays * 86_400_000) continue // still active: lazy
    const old = items.filter((r) => now.getTime() - parseTime(r.createdAt).getTime() >= config.windowDays * 86_400_000)
    const buckets = new Map<string, EventRecord[]>()
    for (const record of old) {
      const period = periodKey(parseTime(record.createdAt), config.period)
      buckets.set(period, [...(buckets.get(period) ?? []), record])
    }
    for (const period of [...buckets.keys()].sort()) {
      const bucket = buckets.get(period)!
      if (bucket.length >= config.minEvents) plans.push({ timeline: JSON.parse(key) as [string, string, string], period, events: bucket })
    }
  }
  return plans
}

export async function summarizeTimeline(model: ChatModel, plan: CompressPlan, language: string, calls: ModelCall[]): Promise<Record<string, unknown>> {
  const listing = plan.events.map((r) => `- [${r.createdAt.slice(0, 10)}] (${r.type}) ${r.content}`).join('\n')
  return model.completeJson([
    {
      role: 'system',
      content:
        'Bạn nén một dòng thời gian ký ức thành một bản tóm tắt. Giữ MỌI con số, tên riêng, quyết định và mốc thời ' +
        'gian còn có giá trị; khi hai ghi nhớ mâu thuẫn, giữ cái mới hơn và nêu giá trị cũ trong ngoặc. Không thêm ' +
        `thông tin mới. Viết bằng ${language}. Chỉ trả JSON: ` +
        '{"summary": "<tối đa 6 câu>", "keywords": ["..."], "importance": 0.0}',
    },
    { role: 'user', content: `Chủ đề: ${plan.timeline[2] || 'chung'} — kỳ ${plan.period}\n\n${listing}` },
  ], 'memory-compress', calls)
}

export function summaryRecord(plan: CompressPlan, answer: Record<string, unknown>): EventRecord {
  const first = plan.events[0]!
  const maxImportance = Math.max(...plan.events.map((r) => r.importance))
  const raw = Number(answer.importance ?? maxImportance)
  const importance = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : maxImportance
  const given = (Array.isArray(answer.keywords) ? answer.keywords : []).map(String).slice(0, 6)
  const keywords = given.length > 0 ? given : [...new Set(plan.events.flatMap((r) => r.keywords))].slice(0, 6)
  return {
    id: randomUUID(), userId: first.userId, sessionId: first.sessionId, scope: first.scope, type: SUMMARY_TYPE,
    content: String(answer.summary ?? '').trim(), props: { period: plan.period, count: plan.events.length },
    importance, topic: first.topic, ranges: '', source: plan.events.map((r) => r.content).join('\n').slice(0, 1500), keywords,
    level: 1, createdAt: plan.events[plan.events.length - 1]!.createdAt, expiresAt: null, compressedInto: null, hits: 0, lastAccess: null,
  }
}

/** [delete, postpone] for compressed details past their TTL. */
export function expiryDecisions(records: EventRecord[], config: CompressConfig, now: Date): [string[], string[]] {
  const remove: string[] = []
  const postpone: string[] = []
  for (const record of records) {
    const accessed = record.lastAccess ? parseTime(record.lastAccess) : undefined
    if (accessed && now.getTime() - accessed.getTime() < config.reinforceDays * 86_400_000) postpone.push(record.id)
    else remove.push(record.id)
  }
  return [remove, postpone]
}

/** LLM_MERGE: one note from the old one and the new information, wrong parts replaced, under `maxChars`. */
export async function mergeText(model: ChatModel, current: string, addition: string, language: string, maxChars: number, calls: ModelCall[]): Promise<string> {
  const answer = await model.completeJson([
    {
      role: 'system',
      content:
        'Bạn hợp nhất một ghi chú với thông tin mới. Trước hết xác định ý nào của ghi chú cũ bị thông tin mới thay đổi ' +
        'hoặc làm sai; viết lại ghi chú: giữ mọi ý cũ còn đúng, thay ý đã sai bằng ý mới, bỏ lặp, giữ nguyên con số và ' +
        `tên riêng, không thêm điều không có. Tối đa ${String(maxChars)} ký tự. Viết bằng ${language}. ` +
        'Chỉ trả JSON: {"changes": ["<ý đã thay>"], "text": "<ghi chú mới>"}',
    },
    { role: 'user', content: `Ghi chú hiện tại:\n${current}\n\nThông tin mới:\n${addition || '(không — chỉ rút gọn)'}` },
  ], 'memory-merge', calls)
  const text = String(answer.text ?? '').trim()
  return text ? text.slice(0, maxChars) : current
}

/** For each (new, nearest old) pair: is the new one entirely the same as the old one? */
export async function resolveDuplicates(model: ChatModel, pairs: [string, string][], calls: ModelCall[]): Promise<boolean[]> {
  if (pairs.length === 0) return []
  const listing = pairs.map(([fresh, old], i) => `[${String(i)}] MỚI: ${fresh}\n    CŨ: ${old}`).join('\n')
  const answer = await model.completeJson([
    {
      role: 'system',
      content:
        'Với mỗi cặp, ghi nhớ MỚI có hoàn toàn trùng ý ghi nhớ CŨ không (không thêm, không đổi thông tin nào)? ' +
        'Khác con số, khác thời điểm hay thêm chi tiết là KHÔNG trùng. Chỉ trả JSON: {"duplicate": [true/false theo thứ tự]}',
    },
    { role: 'user', content: listing },
  ], 'memory-dedup', calls)
  const flags = Array.isArray(answer.duplicate) ? answer.duplicate : []
  return pairs.map((_, i) => Boolean(flags[i]))
}

/** Groups of keys that name the same thing (each group ≥ 2 indices). */
export async function consolidateKeys(model: ChatModel, schemaName: string, labels: string[], calls: ModelCall[]): Promise<number[][]> {
  const listing = labels.map((label, i) => `[${String(i)}] ${label}`).join('\n')
  const answer = await model.completeJson([
    {
      role: 'system',
      content:
        `Đây là các khoá của entity ${schemaName} trong cùng một phạm vi. Nhóm những khoá chỉ CÙNG MỘT thứ (viết khác ` +
        'nhau, viết tắt, thêm bớt từ). Khoá chỉ hai thứ khác nhau thì KHÔNG nhóm; không chắc thì bỏ qua. ' +
        'Chỉ trả JSON: {"groups": [[chỉ số, ...], ...]} — chỉ nhóm có từ 2 khoá.',
    },
    { role: 'user', content: listing },
  ], 'memory-keys', calls)
  const groups: number[][] = []
  for (const group of Array.isArray(answer.groups) ? answer.groups : []) {
    if (!Array.isArray(group)) continue
    const ids = [...new Set(group.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < labels.length))].sort((a, b) => a - b)
    if (ids.length >= 2) groups.push(ids)
  }
  return groups
}
