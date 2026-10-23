// Broken Qwen tool calls: repaired, recovered from prose, or failed with a code dsh-llm-retry re-runs.
//   node --experimental-transform-types --test packages/llm/openai-compat/test/repair.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { StreamChunk } from '@deepseek-ai/dsh-llm'

import { serializeRequest } from '../src/serialize.ts'
import { repairToolCall, wireArguments } from '../src/tool-call-repair.ts'
import { translate } from '../src/translate.ts'

async function* frames(...chunks: unknown[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield JSON.stringify(chunk)
  yield '[DONE]'
}

async function run(...chunks: unknown[]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of translate(frames(...chunks))) out.push(chunk)
  return out
}

const ends = (chunks: StreamChunk[]) => chunks.flatMap((c) => (c.type === 'block-end' ? [c.block] : []))
const finish = (chunks: StreamChunk[]) => chunks.find((c) => c.type === 'finish')

test('repair: ChatML markup in keys, markup arguments, names, empty arguments', () => {
  const keys = repairToolCall('data_query', JSON.stringify({ '\n<parameter=save_as': 'x.xlsx', save_as: 'x.xlsx', sql: 'select 1' }))
  assert.deepEqual(JSON.parse(keys.arguments!), { save_as: 'x.xlsx', sql: 'select 1' })
  const markup = repairToolCall('<function=bash>', '<parameter=command>ls -la</parameter><parameter=timeout>10</parameter>')
  assert.equal(markup.name, 'bash')
  assert.deepEqual(JSON.parse(markup.arguments!), { command: 'ls -la', timeout: 10 })
  assert.equal(repairToolCall('bash', '').arguments, '{}')
  assert.equal(repairToolCall('write', '{"content": "# Báo cáo\\n').arguments, undefined)
  assert.equal(wireArguments('write', '{"content": "# Báo cáo\\n'), '{}')
})

test('history: a truncated call from an older turn goes out as valid JSON', () => {
  const body = serializeRequest({
    provider: 'p', model: 'm',
    messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: '{"path": "a.md", "content": "cut' }] }],
  } as never)
  const call = (body.messages as { tool_calls?: { function: { arguments: string } }[] }[]).flatMap((m) => m.tool_calls ?? [])[0]!
  assert.equal(call.function.arguments, '{}')
})

test('a tool call left in the reasoning as markup is lifted out', async () => {
  const chunks = await run(
    { choices: [{ delta: { reasoning_content: 'Cần xem file.\n<tool_call>\n<function=bash>\n<parameter=command>\nwc -l log.txt\n</parameter>\n</function>\n</tool_call>' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  )
  const call = ends(chunks).find((b) => b.type === 'tool-call')
  assert.ok(call && call.type === 'tool-call')
  assert.equal(call.name, 'bash')
  assert.deepEqual(JSON.parse(call.arguments), { command: 'wc -l log.txt' })
  assert.deepEqual(finish(chunks), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('an answer stranded in the reasoning is shown as text, without invented control tags', async () => {
  const chunks = await run({ choices: [{ delta: { reasoning_content: '<system-reminder>Doanh thu tháng 9 tăng 38,7%.</system-reminder>' }, finish_reason: 'stop' }] })
  const text = ends(chunks).find((b) => b.type === 'text')
  assert.ok(text && text.type === 'text')
  assert.equal(text.text, 'Doanh thu tháng 9 tăng 38,7%.')
})

test('a normal answer is left alone', async () => {
  const chunks = await run({ choices: [{ delta: { reasoning_content: 'nghĩ', content: 'Xin chào' }, finish_reason: 'stop' }] })
  assert.deepEqual(ends(chunks).map((b) => b.type).sort(), ['reasoning', 'text'])
  assert.equal(ends(chunks).find((b) => b.type === 'text')?.type === 'text' && (ends(chunks).find((b) => b.type === 'text') as { text: string }).text, 'Xin chào')
})

test('an unrepairable call fails the attempt: MALFORMED_TOOL_CALL, or CONTEXT_WINDOW_EXCEEDED when cut off', async () => {
  const call = (args: string, reason: string) => [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write', arguments: args } }] } }] },
    { choices: [{ delta: {}, finish_reason: reason }] },
  ]
  await assert.rejects(run(...call('{"content": "# Báo cáo', 'length')), (e: { code?: string }) => e.code === 'CONTEXT_WINDOW_EXCEEDED')
  await assert.rejects(run(...call('not json at all', 'tool_calls')), (e: { code?: string }) => e.code === 'MALFORMED_TOOL_CALL')
  const fixed = await run(...call('{"\\n<parameter=path": "a.md", "content": "x"}', 'tool_calls'))
  const block = ends(fixed).find((b) => b.type === 'tool-call')
  assert.ok(block && block.type === 'tool-call')
  assert.deepEqual(JSON.parse(block.arguments), { path: 'a.md', content: 'x' })
})
