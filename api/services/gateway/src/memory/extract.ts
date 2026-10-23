// One extraction call per turn (VikingMem §3.1; port of pynote-memory's extractor.py — the rules text is pynote's,
// verbatim, since that is what its benchmarks measured). The call does four things:
//   A. filter: messages with no lasting value belong to no segment;
//   B. topic segments by message index ("2-3,7"; non-adjacent messages of one topic may share a segment);
//   C. every event type of the schema, each tied to a segment, with keywords for the keyword graph;
//   D. patches for text properties and forget requests.
// The fixed part (rules + schema) comes first so the server reuses the prefix cache; the variable part follows.
// Context messages (earlier turns) are numbered before the new ones and only read: events come from new messages.
import type { ChatModel, ModelCall } from './llm.ts'
import type { Entity } from './store.ts'
import { eventSchema, type EventSchema, type MemorySchema, type Scope } from './schema.ts'
import { fold, formatRanges, hasVietnamese, parseRanges } from './text.ts'

const MAX_MESSAGE_CHARS = 4000
const MAX_SOURCE_CHARS = 1500
export const LANGUAGES: Record<string, string> = { vi: 'tiếng Việt', en: 'English', zh: '中文' }

const RULES = "Bạn trích bộ nhớ dài hạn cho một trợ lý AI. Bạn nhận: sơ đồ các loại event, trạng thái đã biết,\nvà một đoạn hội thoại có đánh số [i]. Các tin có số nhỏ hơn \"tin mới bắt đầu từ\" chỉ là NGỮ CẢNH để hiểu.\n\nLàm theo thứ tự, trong MỘT câu trả lời:\nA. Lọc: bỏ qua tin không có giá trị lâu dài (chào hỏi, cảm ơn, câu đệm, câu hỏi chưa được trả lời,\n   kiến thức chung trợ lý giải thích).\nB. Phân đoạn: chia các tin đáng giữ thành đoạn theo CHỦ ĐỀ. `ranges` là các chỉ số, dạng \"2-3,7\";\n   một đoạn được gồm các tin không liền nhau nếu cùng chủ đề; hai chủ đề xen nhau thì tách thành hai đoạn.\n   Đoạn được phép gồm tin ngữ cảnh nếu cùng chủ đề với tin mới.\nC. Trích event: chỉ từ thông tin xuất hiện trong TIN MỚI. Mỗi event một ý, đúng một loại của sơ đồ,\n   đủ thuộc tính bắt buộc, `segment` = id của đoạn chứa nó.\nD. Vá văn bản và quên (xem dưới).\n\nLuật cho event:\n0. PHỦ ĐỦ: mỗi chi tiết cụ thể có giá trị về sau (tên người, nơi chốn, con số, tên sách/bài hát/tổ chức, việc đã\n   làm kèm thời điểm, quan hệ, sở thích) là MỘT event riêng — không gộp nhiều chi tiết vào một event, không bỏ chi\n   tiết vì cho là nhỏ. Một đoạn hội thoại giàu thông tin thường cho nhiều event.\n1. Chỉ bỏ điều mà trạng thái đã biết ghi Y HỆT; điều mới hoặc đã thay đổi thì trích.\n2. Giữ nguyên con số, đơn vị, tên riêng. Không tự tính ra số mới; kết quả tính do trợ lý đưa ra mà\n   người dùng không phản đối thì được ghi, `note` ghi \"kết quả tính\".\n3. Nói về một thứ đã có trong trạng thái đã biết thì dùng ĐÚNG khoá (key/topic/task/aspect) đã có để\n   giá trị mới thay giá trị cũ; người dùng sửa một con số → event mới cùng khoá, `note` nêu giá trị cũ.\n4. Loại phạm vi \"user\" chỉ dành cho điều đúng với người dùng ở MỌI cuộc chat, đúng như mô tả của loại.\n   Số liệu, ngân sách, thông số, giả định của một dự án luôn thuộc loại phạm vi \"session\".\n   Phân vân thì chọn loại phạm vi \"session\".\n5. Thời gian: thuộc tính kiểu `date` chép NGUYÊN VĂN cụm thời gian người nói dùng (\"last Friday\", \"two weekends\n   ago\", \"tuần trước\", \"hôm qua\", \"5 July 2023\", \"in 2022\") — KHÔNG tự quy đổi, hệ thống tự tính ngày theo ngày\n   của đoạn hội thoại. Sự việc có mốc thời gian thì PHẢI điền thuộc tính đó. Không có mốc thì bỏ trống, không bịa.\n6. `content`: một câu tự đủ nghĩa (đọc riêng vẫn hiểu), không quá 300 ký tự.\n7. `keywords`: 2–5 từ khoá ngắn (danh từ, tên riêng, mã, chủ đề) giúp tìm lại event này về sau.\n8. `importance` 0–1: 1 = quyết định/số liệu then chốt, 0.3 = chi tiết phụ.\n9. Tin của Trợ lý chỉ để hiểu ngữ cảnh. KHÔNG trích từ lời trợ lý: đề xuất, phương án, kế hoạch, câu hỏi, việc trợ lý\n   nhờ người dùng làm, bản nháp, lời trợ lý tự nói đã làm xong. Ngoại lệ: con số/kết quả tính/phương án trợ lý đưa ra ở\n   tin TRƯỚC mà tin mới của người dùng chấp nhận, chọn hoặc dùng tiếp → ghi, `note` ghi \"kết quả tính\" hoặc \"người dùng\n   chọn\". `task` chỉ là việc NGƯỜI DÙNG giao; `status` done khi việc đó đã được làm xong trong hội thoại.\n\nVá văn bản: chỉ cho thuộc tính ở mục \"Thuộc tính văn bản\". `search` là đoạn NGUYÊN VĂN trong giá trị\nhiện tại cần thay (rỗng = thêm vào cuối), `replace` là đoạn mới. Chỉ vá khi tin mới làm nội dung đó đổi.\n\nQuên: người dùng yêu cầu bỏ/quên/xoá một điều đã nhớ, hoặc nói điều đó không còn đúng mà không đưa giá\ntrị mới → thêm {\"entity\": \"<tên entity>\", \"key\": \"<khoá như trong trạng thái đã biết>\"} vào `forget`.\n\nViết `content`, giá trị thuộc tính và từ khoá bằng {language}.\n\nChỉ trả về một đối tượng JSON:\n{\"segments\":[{\"id\":0,\"topic\":\"<chủ đề ngắn>\",\"ranges\":\"2-3,7\"}],\n \"events\":[{\"type\":\"<loại>\",\"segment\":0,\"properties\":{...},\"content\":\"<câu>\",\"keywords\":[\"...\"],\"importance\":0.0}],\n \"patches\":[{\"entity\":\"<tên entity>\",\"key\":\"<khoá hoặc rỗng>\",\"property\":\"<thuộc tính>\",\"search\":\"<đoạn cũ>\",\"replace\":\"<đoạn mới>\"}],\n \"forget\":[{\"entity\":\"<tên entity>\",\"key\":\"<khoá>\"}]}\nKhông có gì thì trả {\"segments\":[],\"events\":[],\"patches\":[],\"forget\":[]}."

// The member said it is lasting — the condition for a convention to reach the user scope.
const LASTING = /\b(tu nay|tu gio|tu bay gio|ve sau|sau nay|lan sau|moi lan|moi cuoc|moi bao cao|luon luon|luon dung|mac dinh|binh thuong|thong thuong|thuong ngay|cho tat ca|from now on|always|by default|in future)\b/
const CHAT_ONLY = /\b(cuoc (chat|tro chuyen|hoi thoai) nay|(trong|cho|o) (chat|phien) nay|lan nay|tam thoi|rieng du an|this chat|for now)\b/
const NUMBER = /\d/

export type Message = { role: 'user' | 'assistant'; content: string; name?: string }

export interface Segment { id: number; topic: string; indices: number[] }

export interface ExtractedEvent {
  type: string
  properties: Record<string, unknown>
  content: string
  importance: number
  scope: Scope
  keywords: string[]
  topic: string
  ranges: string
  source: string
  demotedFrom?: string
}

export interface ExtractedPatch { entity: string; key: string; property: string; search: string; replace: string }
export interface ForgetRequest { entity: string; key: string }

export interface Extraction {
  events: ExtractedEvent[]
  patches: ExtractedPatch[]
  forget: ForgetRequest[]
  segments: Segment[]
  dropped: string[]
  /** new messages in no segment (the filter phase) */
  noise: number[]
}

export const emptyExtraction = (): Extraction => ({ events: [], patches: [], forget: [], segments: [], dropped: [], noise: [] })

export function schemaBlock(schema: MemorySchema): string {
  const lines: string[] = []
  if (schema.instructions.trim()) lines.push(`## Hướng dẫn riêng (thắng luật chung khi khác nhau)\n${schema.instructions.trim()}\n`)
  lines.push('## Sơ đồ các loại event')
  for (const event of schema.events) {
    const props = event.properties
      .map((p) => `${p.name} (${p.type ?? 'string'}${p.required ? ', bắt buộc' : ''})${p.description ? `: ${p.description}` : ''}`)
      .join('; ')
    lines.push(`- ${event.name} [phạm vi ${event.scope}]: ${event.description.trim()}\n  thuộc tính: ${props}`)
  }
  const textProps = schema.entities.flatMap((e) => e.properties.filter((p) => p.aggregate.op === 'LLM_MERGE').map((p) => `${e.name}.${p.name}`))
  if (textProps.length > 0) lines.push(`\n## Thuộc tính văn bản (cập nhật bằng bản vá)\n${textProps.join(', ')}`)
  lines.push(`\n## Entity\n${schema.entities.map((e) => `${e.name} (khoá: ${e.key ?? 'không'})`).join(', ')}`)
  return lines.join('\n')
}

const shown = (value: unknown) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)

export function stateBlock(entities: Entity[]): string {
  if (entities.length === 0) return '## Trạng thái đã biết\n(chưa có)'
  const lines = ['## Trạng thái đã biết']
  for (const entity of entities) {
    const values = Object.entries(entity.state).filter(([k, v]) => !k.startsWith('_') && shown(v)).map(([k, v]) => `${k}: ${String(v)}`).join('; ')
    const label = (entity.state._label as string | undefined) || entity.key
    lines.push(`- ${entity.schema}${label ? `[${label}]` : ''} (${entity.scope}): ${values}`)
  }
  return lines.join('\n')
}

function clip(content: string): string {
  return content.length > MAX_MESSAGE_CHARS ? `${content.slice(0, MAX_MESSAGE_CHARS / 2)}\n…\n${content.slice(-MAX_MESSAGE_CHARS / 2)}` : content
}

export function numberMessages(context: Message[], fresh: Message[]): [Message[], number] {
  const keep = (list: Message[]) => list.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
  const ctx = keep(context)
  return [[...ctx, ...keep(fresh)], ctx.length]
}

export function conversationBlock(messages: Message[], firstNew: number): string {
  const names = { user: 'Người dùng', assistant: 'Trợ lý' }
  const parts = [`## Hội thoại (tin mới bắt đầu từ [${String(firstNew)}])`]
  messages.forEach((m, i) => parts.push(`[${String(i)}] ${m.name ?? names[m.role]}: ${clip(m.content.trim())}`))
  return parts.join('\n\n')
}

export class Extractor {
  private readonly fixed = new Map<string, string>()

  constructor(private readonly schema: MemorySchema, private readonly model: ChatModel, private readonly language = 'vi') {}

  languageName(messages: Message[]): string {
    if (this.language !== 'auto') return LANGUAGES[this.language] ?? this.language
    const users = messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ')
    return hasVietnamese(users) ? LANGUAGES.vi! : "the same language as the user's messages"
  }

  systemPrompt(language: string): string {
    let prompt = this.fixed.get(language)
    if (!prompt) {
      prompt = `${RULES.replaceAll('{language}', language)}\n\n${schemaBlock(this.schema)}`
      this.fixed.set(language, prompt)
    }
    return prompt
  }

  messages(numbered: Message[], firstNew: number, known: Entity[], today: string): { role: 'system' | 'user'; content: string }[] {
    const variable = `Hôm nay: ${today}\n\n${stateBlock(known)}\n\n${conversationBlock(numbered, firstNew)}`
    return [{ role: 'system', content: this.systemPrompt(this.languageName(numbered)) }, { role: 'user', content: variable }]
  }

  async extract(fresh: Message[], known: Entity[], calls: ModelCall[], options: { context?: Message[]; today?: string } = {}): Promise<Extraction> {
    const [numbered, firstNew] = numberMessages(options.context ?? [], fresh)
    if (firstNew >= numbered.length) return emptyExtraction()
    const raw = await this.model.completeJson(this.messages(numbered, firstNew, known, options.today ?? new Date().toISOString().slice(0, 10)), 'memory-extract', calls)
    return this.validate(raw, numbered, firstNew)
  }

  // ---- output checks ----------------------------------------------------------------------------------------------

  validate(raw: Record<string, unknown>, numbered: Message[], firstNew: number): Extraction {
    const out = emptyExtraction()
    const n = numbered.length
    const userText = fold(numbered.slice(firstNew).filter((m) => m.role === 'user').map((m) => m.content).join(' '))

    const segments = new Map<number, Segment>()
    for (const item of Array.isArray(raw.segments) ? raw.segments : []) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const indices = parseRanges(String(record.ranges ?? ''), n)
      const id = Number(record.id ?? segments.size)
      if (!Number.isInteger(id)) continue
      if (indices.length > 0 && indices.some((i) => i >= firstNew)) segments.set(id, { id, topic: String(record.topic ?? '').trim(), indices })
    }
    out.segments = [...segments.values()]
    const covered = new Set(out.segments.flatMap((s) => s.indices))
    for (let i = firstNew; i < n; i++) if (!covered.has(i)) out.noise.push(i)
    const allNew = Array.from({ length: n - firstNew }, (_, k) => firstNew + k)

    for (const item of Array.isArray(raw.events) ? raw.events : []) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const event = eventSchema(this.schema, String(record.type ?? ''))
      if (!event) {
        out.dropped.push(`loại lạ: ${String(record.type)}`)
        continue
      }
      const given = record.properties && typeof record.properties === 'object' ? (record.properties as Record<string, unknown>) : {}
      const props: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(given)) if (event.properties.some((p) => p.name === k) && v !== null && v !== undefined && v !== '') props[k] = v
      const missing = event.properties.filter((p) => p.required && !(p.name in props)).map((p) => p.name)
      if (missing.length > 0) {
        out.dropped.push(`${event.name} thiếu ${missing.join(', ')}`)
        continue
      }
      const content = String(record.content ?? '').trim() || Object.entries(props).map(([k, v]) => `${k}: ${String(v)}`).join('; ')
      const importanceRaw = Number(record.importance ?? 0.5)
      const importance = Number.isFinite(importanceRaw) ? Math.min(1, Math.max(0, importanceRaw)) : 0.5
      const keywords = (Array.isArray(record.keywords) ? record.keywords : []).map((k) => String(k).trim()).filter(Boolean).slice(0, 6)
      const segment = segments.get(Number(record.segment))
      // rule 9 in code: what only the assistant said (a proposal, a question, "done") is not the member's memory —
      // the segment it comes from must hold a new message of the member (accepting a figure counts)
      if (segment && !segment.indices.some((i) => i >= firstNew && numbered[i]!.role === 'user')) {
        out.dropped.push(`${event.name} chỉ từ lời trợ lý: ${content.slice(0, 80)}`)
        continue
      }
      const indices = segment ? segment.indices : allNew
      const source = indices.map((i) => `[${String(i)}] ${numbered[i]!.name ?? numbered[i]!.role}: ${numbered[i]!.content.trim()}`).join('\n').slice(0, MAX_SOURCE_CHARS)
      out.events.push(this.guardScope({
        type: event.name, properties: props, content: content.slice(0, 600), importance, scope: event.scope, keywords,
        topic: segment ? segment.topic : '', ranges: formatRanges(indices), source,
      }, event, userText))
    }

    for (const item of Array.isArray(raw.patches) ? raw.patches : []) {
      const p = item as Record<string, unknown>
      if (p && typeof p === 'object' && p.entity && p.property && p.replace) {
        out.patches.push({ entity: String(p.entity), key: String(p.key ?? ''), property: String(p.property), search: String(p.search ?? ''), replace: String(p.replace) })
      }
    }
    for (const item of Array.isArray(raw.forget) ? raw.forget : []) {
      const f = item as Record<string, unknown>
      if (f && typeof f === 'object' && f.entity) out.forget.push({ entity: String(f.entity), key: String(f.key ?? '') })
    }
    return out
  }

  /**
   * The scope guard in code (the leak measured on Mem0): a preference needs a lasting cue and no "this chat only";
   * a profile carries no number (project figures are not the member's profile). Otherwise it is demoted to a
   * session-scope decision, nothing lost.
   */
  guardScope(extracted: ExtractedEvent, event: EventSchema, userText: string): ExtractedEvent {
    if (event.scope !== 'user' || (event.name !== 'preference' && event.name !== 'profile')) return extracted
    const lasting = LASTING.test(userText) && !CHAT_ONLY.test(userText)
    if (event.name === 'preference' && lasting) return extracted
    if (event.name === 'profile' && !NUMBER.test(String(extracted.properties.value ?? ''))) return extracted
    if (!eventSchema(this.schema, 'decision')) return extracted
    const aspect = String(extracted.properties.aspect ?? '').trim() || 'quy ước'
    const value = String(extracted.properties.value ?? '').trim()
    return { ...extracted, type: 'decision', scope: 'session', demotedFrom: event.name, properties: { topic: aspect, decision: value } }
  }
}
