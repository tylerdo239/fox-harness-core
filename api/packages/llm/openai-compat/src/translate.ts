import { randomUUID } from 'node:crypto'

import type { CallId, ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@deepseek-ai/dsh-llm'

import { MALFORMED_TOOL_CALL_CODE, repairToolCall } from './tool-call-repair.ts'

/**
 * OpenAI chat-completions streaming delta shapes — request-side fields
 * omitted, this is only what a `choices[0].delta` / chunk-level `usage` looks
 * like on the wire. Adapted from the real dsh-llm-deepseek adapter's
 * translate.ts, generalized (drops the DeepSeek-only assumption that every
 * server sends `reasoning_content`; kept as an optional pass-through since
 * some OpenAI-compatible reasoning models do send it too).
 */
interface WireToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface WireDelta {
  content?: string
  reasoning_content?: string
  tool_calls?: WireToolCallDelta[]
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  // OpenAI and vLLM/DeepSeek-style servers: the cached part of the prompt, the reasoning part of the completion
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
  prompt_cache_hit_tokens?: number
}

interface WireChunk {
  choices?: Array<{ delta?: WireDelta; finish_reason?: string | null }>
  usage?: WireUsage
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: CallId
  name?: string
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    case null:
    case undefined:
      return { kind: 'stop' }
    default:
      return { kind: 'error', failure: { message: `unknown finish_reason: ${reason}`, code: reason.toUpperCase() } }
  }
}

/**
 * Qwen-family recovery (ported from examples/pynote-be, measured there on
 * Qwen3.5-35B on vLLM): the server sometimes puts a tool call in
 * `reasoning_content` (or the text) as ChatML markup instead of `tool_calls`
 *   <tool_call><function=bash><parameter=command>…</parameter></function></tool_call>
 * and the step then has neither text nor a tool call, which the loop reads as
 * "done": the user sees no answer while the turn reports `completed`.
 * Recovery only runs when the response produced no real tool call, so a
 * well-formed response is never second-guessed.
 */
const TOOL_CALL_MARKUP = /<tool_call>\s*<function=([A-Za-z0-9_]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g
const PARAMETER_MARKUP = /<parameter=([A-Za-z0-9_]+)>([\s\S]*?)<\/parameter>/g

/** Markup carries every argument as text; tool schemas do not accept "10" for a number. */
function coerceArgument(raw: string): unknown {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value !== '' && Number.isFinite(Number(value))) return Number(value)
  return value
}

function recoverToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  if (!text.includes('<tool_call>')) return []
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  for (const [, name, body] of text.matchAll(TOOL_CALL_MARKUP)) {
    const args: Record<string, unknown> = {}
    for (const [, key, value] of body!.matchAll(PARAMETER_MARKUP)) args[key!] = coerceArgument(value ?? '')
    calls.push({ name: name!, args })
  }
  return calls
}

/**
 * The same silent turn, second shape: no markup, the model puts its finished
 * ANSWER in `reasoning_content` and leaves `content` empty (sometimes wrapped
 * in a `<system-reminder>` it invented). Promoted to text as a last resort —
 * only when the response has no visible text and no tool call — with the
 * fabricated control tags stripped.
 */
const FABRICATED_CONTROL_TAG = /<\/?system-reminder>/g

function toContentBlock(block: OpenBlock): ContentBlock {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  return { type: 'tool-call', id: block.callId as CallId, name: block.name ?? '', arguments: block.text }
}

/**
 * Turn parsed SSE payload strings (from sse.ts) into the harness's
 * `StreamChunk` protocol. All `block-end`/`usage`/`finish` chunks are
 * deferred until `[DONE]`, then emitted in the order blocks were opened —
 * matches the real dsh-llm-deepseek adapter's translate.ts. `index` here is
 * the HARNESS block index (a fresh counter), distinct from the wire's own
 * `tool_calls[].index` (which only disambiguates concurrent tool-call deltas
 * within one response and is never itself harness-visible).
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const openOrder: OpenBlock[] = []
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocksByWireIndex = new Map<number, OpenBlock>()
  let usage: TokenUsage | undefined
  let finishReason: FinishReason = { kind: 'stop' }

  function openBlock(kind: 'text' | 'reasoning'): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    openOrder.push(block)
    return block
  }

  function openToolBlock(wireIndex: number, id: string | undefined, name: string | undefined): OpenBlock {
    let block = toolBlocksByWireIndex.get(wireIndex)
    if (!block) {
      block = { index: nextIndex++, kind: 'tool-call', text: '', callId: id as CallId, name }
      toolBlocksByWireIndex.set(wireIndex, block)
      openOrder.push(block)
    }
    return block
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') break

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload)
    } catch (error) {
      // Bug fix 2026-09-09 (docs/security-performance-review-2026-09-09.md's
      // Bug #3): this used to swallow a malformed SSE payload completely
      // silently — if the LLM server occasionally sends a broken frame,
      // content is lost with zero trace to debug it later. Still ignores
      // the frame rather than aborting the whole stream (unchanged
      // behavior — one bad frame shouldn't kill an otherwise-good turn),
      // just no longer silent about it.
      console.error('fox-harness-llm-openai-compat: malformed SSE payload, skipping:', payload, error)
      continue
    }

    if (chunk.usage) {
      // docs/admin-usage-dashboard-plan.md §3.3: cache and reasoning tokens kept too (dsh TokenUsage has the fields)
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens
      const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(typeof cached === 'number' ? { cacheReadTokens: cached } : {}),
        ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
      }
    }

    const choice = chunk.choices?.[0]
    if (!choice) continue

    if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason)

    const delta = choice.delta
    if (!delta) continue

    if (delta.content) {
      if (!textBlock) {
        textBlock = openBlock('text')
        yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
      }
      textBlock.text += delta.content
      yield { type: 'text-delta', index: textBlock.index, text: delta.content }
    }

    if (delta.reasoning_content) {
      if (!reasoningBlock) {
        reasoningBlock = openBlock('reasoning')
        yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
      }
      reasoningBlock.text += delta.reasoning_content
      yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta.reasoning_content }
    }

    for (const toolCallDelta of delta.tool_calls ?? []) {
      const isNew = !toolBlocksByWireIndex.has(toolCallDelta.index)
      const block = openToolBlock(toolCallDelta.index, toolCallDelta.id, toolCallDelta.function?.name)
      if (isNew) yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      const argumentsDelta = toolCallDelta.function?.arguments ?? ''
      if (argumentsDelta) block.text += argumentsDelta
      if (toolCallDelta.function?.name && !block.name) block.name = toolCallDelta.function.name
      // `name` is optional on StreamChunk's tool-call-delta variant, but an
      // explicit `{ name: undefined }` is NOT the same as omitting the key —
      // confirmed the hard way: dsh's session.append() rejects explicit
      // `undefined` as non-JSON-serializable (JSON.stringify would silently
      // drop it; dsh's own validator does not). Most deltas after the first
      // one for a given tool call have no `function.name` at all.
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: block.callId as CallId,
        argumentsDelta,
        ...(toolCallDelta.function?.name ? { name: toolCallDelta.function.name } : {}),
      }
    }
  }

  // A call the server left in prose (TOOL_CALL_MARKUP above) is lifted out once the whole response is in hand.
  if (toolBlocksByWireIndex.size === 0) {
    for (const block of [...openOrder]) {
      const recovered = recoverToolCalls(block.text)
      if (recovered.length === 0) continue
      block.text = block.text.replace(TOOL_CALL_MARKUP, '').trim()
      for (const call of recovered) {
        const callId = `call_recovered_${randomUUID().replace(/-/g, '')}` as CallId
        const args = JSON.stringify(call.args)
        const recoveredBlock: OpenBlock = { index: nextIndex++, kind: 'tool-call', text: args, callId, name: call.name }
        openOrder.push(recoveredBlock)
        yield { type: 'block-start', index: recoveredBlock.index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: recoveredBlock.index, id: callId, argumentsDelta: args, name: call.name }
      }
      finishReason = { kind: 'tool-calls' }
    }
  }

  // Every tool call leaves here as a usable JSON object (tool-call-repair.ts). One that stays broken fails this
  // attempt so dsh-llm-retry runs the step again (adapter.ts providerRetryPolicy) — as CONTEXT_WINDOW_EXCEEDED when
  // the output ran out of room, so compaction makes space first. The broken attempt never reaches history.
  for (const block of openOrder) {
    if (block.kind !== 'tool-call') continue
    const repaired = repairToolCall(block.name ?? '', block.text)
    if (repaired.fixes.length > 0) console.error(`fox-harness-llm-openai-compat: repaired tool call ${repaired.name}: ${repaired.fixes.join('; ')}`)
    block.name = repaired.name
    if (repaired.arguments !== undefined) {
      block.text = repaired.arguments
      continue
    }
    const preview = block.text.length > 160 ? `${block.text.slice(0, 160)}…` : block.text
    if (finishReason.kind === 'max-tokens') {
      throw new LlmError(`the response ran out of room in the middle of a ${repaired.name} call (${String(block.text.length)} characters of arguments); compacting before retrying`, CONTEXT_WINDOW_EXCEEDED_CODE)
    }
    throw new LlmError(`malformed ${repaired.name} call, arguments are not a JSON object: ${preview}`, MALFORMED_TOOL_CALL_CODE)
  }

  // See FABRICATED_CONTROL_TAG above.
  if (!openOrder.some((block) => block.kind === 'tool-call' || (block.kind === 'text' && block.text.trim() !== ''))) {
    const stranded = openOrder
      .filter((block) => block.kind === 'reasoning')
      .map((block) => block.text.replace(FABRICATED_CONTROL_TAG, '').trim())
      .filter((text) => text !== '')
      .join('\n\n')
    if (stranded !== '') {
      const promoted: OpenBlock = { index: nextIndex++, kind: 'text', text: stranded }
      openOrder.push(promoted)
      yield { type: 'block-start', index: promoted.index, blockType: 'text' }
      yield { type: 'text-delta', index: promoted.index, text: stranded }
    }
  }

  for (const block of openOrder) {
    yield { type: 'block-end', index: block.index, block: toContentBlock(block) }
  }
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: finishReason }
}
