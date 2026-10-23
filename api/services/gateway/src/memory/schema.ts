// The memory's Event–Entity schema (VikingMem §2.2; port of pynote-memory's schema.py + schemas/pynote.yaml, same
// event types, entities, weights and operators, so its measurements still say something about this code).
//
// Scope is decided by the schema, not guessed by the model:
//   session — only this chat (figures, decisions, open tasks, the chat's goal);
//   user    — true for the member in EVERY chat: their role, and conventions they said apply from now on. Never a
//             project's figures (the "one chat's numbers leak into another" bug measured on Mem0).
import type { Op } from './operators.ts'

export type Scope = 'user' | 'session'

export interface PropertySpec {
  name: string
  type?: 'string' | 'number' | 'boolean' | 'list' | 'date'
  description?: string
  required?: boolean
}

export interface EventSchema {
  name: string
  description: string
  scope: Scope
  properties: PropertySpec[]
  /** business weight of the type when ranking (S_busi), 0..1 */
  weight: number
  /** days a detail event lives (undefined: kept) */
  ttlDays?: number
}

export interface EntityProperty {
  name: string
  aggregate: { op: Op; event: string; field: string }
}

export interface EntitySchema {
  name: string
  description: string
  scope: Scope
  /** the event property that groups events into entities ("ngân sách", "số drone"); none: one entity per scope */
  key?: string
  properties: EntityProperty[]
}

export interface MemorySchema {
  instructions: string
  events: EventSchema[]
  entities: EntitySchema[]
}

export const SCHEMA: MemorySchema = {
  instructions:
    '"Người dùng" là thành viên của tổ chức, "Trợ lý" là Fox Harness AI Agent. Ghi điều người dùng nêu, chốt hoặc sửa. Kết quả ' +
    'trợ lý tính hay đề xuất chỉ ghi khi người dùng chấp nhận (dùng tiếp, không phản đối). Ghi cả LÝ DO của một quyết định khi ' +
    'người dùng nói ra. Nhận xét hay yêu cầu sửa của người dùng về sản phẩm đang làm (bảng, báo cáo, canvas: màu, cột, thứ tự, ' +
    'giọng văn) là quyết định áp dụng cho các bản sau — ghi thành decision. Không ghi lại nội dung tài liệu hay bảng số liệu dài: ' +
    'chỉ con số và điều đã chốt.',
  events: [
    {
      name: 'fact',
      scope: 'session',
      weight: 0.8,
      description:
        'Một dữ kiện hoặc con số cụ thể người dùng nêu, hoặc kết quả tính toán đã được chấp nhận trong cuộc chat (thông số, số ' +
        'lượng, ngân sách, chi phí, kết quả hoàn vốn…). Mỗi dữ kiện một event; khi người dùng sửa một con số thì trích event mới ' +
        'cùng `key` với giá trị mới.',
      properties: [
        { name: 'key', required: true, description: 'tên ngắn, ổn định của dữ kiện, chữ thường, ví dụ: ngân sách dự án, số drone, dung tích bình' },
        { name: 'value', required: true, description: 'giá trị như người dùng nói, giữ nguyên con số và đơn vị, ví dụ: 500 triệu đồng' },
        { name: 'note', description: 'ngữ cảnh ngắn nếu cần: thay cho giá trị nào, giả định gì' },
        { name: 'when', type: 'date', description: 'thời điểm của sự việc nếu có, chép nguyên văn cụm người dùng nói, ví dụ: hôm qua, tuần trước, thứ Sáu tuần sau, 15/11/2026' },
      ],
    },
    {
      name: 'decision',
      scope: 'session',
      weight: 0.9,
      description:
        'Điều đã được chốt hoặc thống nhất trong cuộc chat: phương án chọn, hạng mục cắt, giả định dùng để tính, yêu cầu về sản ' +
        'phẩm đang làm.',
      properties: [
        { name: 'topic', required: true, description: 'chủ đề ngắn, ổn định, ví dụ: phân bổ ngân sách' },
        {
          name: 'decision',
          required: true,
          description:
            'nội dung đã chốt, đủ để làm lại mà không cần đọc hội thoại; kèm lý do nếu người dùng nêu (một trường, để lý do không ' +
            'sống lâu hơn quyết định)',
        },
      ],
    },
    {
      name: 'task',
      scope: 'session',
      weight: 0.6,
      description: 'Việc người dùng giao hoặc việc còn dở, và khi nó được hoàn thành.',
      properties: [
        { name: 'task', required: true, description: 'mô tả ngắn, ổn định của việc' },
        { name: 'status', required: true, description: 'open hoặc done' },
        { name: 'when', type: 'date', description: 'hạn hoặc thời điểm của việc nếu người dùng nêu, chép nguyên văn, ví dụ: thứ Hai tuần sau, cuối tháng này' },
      ],
    },
    {
      name: 'goal',
      scope: 'session',
      weight: 0.7,
      description:
        'Mục tiêu, phạm vi hoặc bối cảnh công việc của cuộc chat (đang làm gì, cho ai, sản phẩm cuối là gì) khi người dùng nêu hoặc ' +
        'thay đổi nó.',
      properties: [{ name: 'summary', required: true, description: 'một đến ba câu' }],
    },
    {
      name: 'profile',
      scope: 'user',
      weight: 0.5,
      description: 'Vai trò, công việc, đơn vị/khu vực phụ trách của chính người dùng. Không ghi số liệu, ngân sách hay thông số của dự án.',
      properties: [
        { name: 'aspect', required: true, description: 'vai trò | công việc | đơn vị | khu vực | tên' },
        { name: 'value', required: true },
      ],
    },
    {
      name: 'preference',
      scope: 'user',
      weight: 0.7,
      description:
        'Quy ước người dùng dặn áp dụng LÂU DÀI ("từ nay", "luôn luôn", "mọi báo cáo"): đơn vị tiền, cách làm tròn, ngôn ngữ, định ' +
        'dạng, giọng văn. Câu chỉ áp dụng cho cuộc chat này, lần này, hoặc một dự án cụ thể thì KHÔNG phải preference.',
      properties: [
        { name: 'aspect', required: true, description: 'khía cạnh, ví dụ: đơn vị tiền, ngôn ngữ báo cáo' },
        { name: 'value', required: true },
      ],
    },
  ],
  entities: [
    {
      name: 'ChatFact',
      scope: 'session',
      key: 'key',
      description: 'Giá trị hiện hành của từng dữ kiện trong cuộc chat (giá trị mới nhất thắng, lịch sử được giữ).',
      properties: [
        { name: 'value', aggregate: { op: 'SET', event: 'fact', field: 'value' } },
        { name: 'note', aggregate: { op: 'SET', event: 'fact', field: 'note' } },
      ],
    },
    {
      name: 'ChatDecision',
      scope: 'session',
      key: 'topic',
      description: 'Quyết định hiện hành theo từng chủ đề.',
      properties: [{ name: 'decision', aggregate: { op: 'SET', event: 'decision', field: 'decision' } }],
    },
    {
      name: 'ChatTask',
      scope: 'session',
      key: 'task',
      description: 'Trạng thái từng việc.',
      properties: [
        { name: 'status', aggregate: { op: 'SET', event: 'task', field: 'status' } },
        { name: 'hạn', aggregate: { op: 'SET', event: 'task', field: 'when' } },
      ],
    },
    {
      name: 'ChatBrief',
      scope: 'session',
      description: 'Tóm tắt mục tiêu và phạm vi của cuộc chat, cập nhật bằng bản vá.',
      properties: [{ name: 'summary', aggregate: { op: 'LLM_MERGE', event: 'goal', field: 'summary' } }],
    },
    {
      name: 'UserProfile',
      scope: 'user',
      key: 'aspect',
      description: 'Hồ sơ người dùng.',
      properties: [{ name: 'value', aggregate: { op: 'SET', event: 'profile', field: 'value' } }],
    },
    {
      name: 'UserPreference',
      scope: 'user',
      key: 'aspect',
      description: 'Quy ước lâu dài của người dùng.',
      properties: [{ name: 'value', aggregate: { op: 'SET', event: 'preference', field: 'value' } }],
    },
  ],
}

export function eventSchema(schema: MemorySchema, name: string): EventSchema | undefined {
  return schema.events.find((e) => e.name === name)
}

export function entitySchema(schema: MemorySchema, name: string): EntitySchema | undefined {
  return schema.entities.find((e) => e.name === name)
}

/** The properties of `entity` an event of `eventType` feeds. */
export function triggeredBy(entity: EntitySchema, eventType: string): EntityProperty[] {
  return entity.properties.filter((p) => p.aggregate.event === eventType)
}

/** The checks pynote runs when it loads a schema: an entity of one scope is never fed by events of the other. */
export function validateSchema(schema: MemorySchema): void {
  const names = schema.events.map((e) => e.name)
  if (new Set(names).size !== names.length) throw new Error('duplicate event type')
  for (const entity of schema.entities) {
    for (const prop of entity.properties) {
      const event = eventSchema(schema, prop.aggregate.event)
      if (!event) throw new Error(`${entity.name}.${prop.name}: no event '${prop.aggregate.event}'`)
      if (event.scope !== entity.scope) throw new Error(`${entity.name}.${prop.name}: event '${event.name}' has another scope`)
      if (!event.properties.some((p) => p.name === prop.aggregate.field)) throw new Error(`${entity.name}.${prop.name}: no field '${prop.aggregate.field}'`)
      if (entity.key && !event.properties.some((p) => p.name === entity.key)) throw new Error(`${entity.name}: event '${event.name}' lacks key '${entity.key}'`)
    }
  }
}

validateSchema(SCHEMA)
