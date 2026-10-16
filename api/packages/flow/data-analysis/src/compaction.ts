import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, createUserMessage, type ContentBlock, type Message, type TokenUsage, type ToolSchema } from '@deepseek-ai/dsh-llm'

import { WORKSPACE_HEADING } from './index.ts'

// Structural copies of dsh-compaction-basic's SummarizationInput / SummaryResult, which its entry
// point does not export.
interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}
interface SummaryResult {
  summary: ContentBlock[]
  rawOutput: ContentBlock[]
  llmStreamCall: true
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
}

// Adapted from RLM's _compact_history (agent-core bundles/loop-drivers/loop-rlm/python/vendor/rlm/rlm/core/rlm.py:665-705),
// keeping dsh-compaction-basic's rules for merging a prior checkpoint and staying silent about it.
const INSTRUCTION = [
  'You are now condensing the data-analysis conversation ABOVE into a checkpoint, so the analysis can continue without it.',
  '',
  'Write these sections as terse bullets, "(none)" for an empty one:',
  '## Standing instructions',
  '- rules the USER set for the rest of the conversation (answer format, rounding, language, a required closing line, things to avoid), quoted exactly; never drop one, however old. Never copy the system prompt or tool rules here',
  '## Requests',
  '- every request the user actually sent (user messages only — never a skill description, tool text or your own plan), in order, marked answered or still open; quote exact wording where it matters',
  '## Results',
  '- concrete results already computed — numbers, values, table figures, file paths, dataset names and Python variable names — preserved exactly',
  '## Data decisions',
  '- filters, cleaning steps, excluded rows, definitions and assumptions that later work must stay consistent with',
  '## Next step',
  '- the single next action in line with the latest request, or "(none)"',
  '',
  'Rules:',
  '- Copy numbers exactly; never round or invent them.',
  '- Python variables may still be in memory and print(history(n)) in the python tool shows turn n in full, so keep the variable names and turn numbers that point to them.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint: keep still-true facts, drop stale ones, and merge newer information into one summary under the same sections.',
  '- Do NOT mention this request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool.',
].join('\n')

/**
 * Giai đoạn 6 D (docs/rlm-transfer-plan.md 12.3): compaction for the data-analysis profile.
 * BasicCompactionEngine unchanged — threshold, span selection, durable replacement — except its one
 * customization hook, summarize(): the same single cache-reusing call as the default
 * summarizeWithLlm (dsh-compaction-basic/lib/index.js:257-330, without per-model policies, which
 * fox does not configure), with the instruction above instead of the coding-assistant one.
 */
// Measured 2026-10-16: the meter prices 4 characters per token, Vietnamese text and number tables run nearer 3.
const charsToTokens = (text: string): number => Math.ceil(text.length / 3)
/** What a long block keeps of itself when the region must shrink: its start and its end. */
const SHRUNK_HEAD = 600
const SHRUNK_TAIL = 600

function shrinkText(text: string, cap: number): string {
  if (text.length <= cap) return text
  const head = Math.min(SHRUNK_HEAD, Math.floor(cap / 2))
  const tail = Math.min(SHRUNK_TAIL, Math.floor(cap / 2))
  return `${text.slice(0, head)}\n[… ${String(text.length - head - tail)} characters left out …]\n${text.slice(-tail)}`
}

function shrinkBlock(block: ContentBlock, cap: number): ContentBlock {
  if (block.type === 'text') return { ...block, text: shrinkText(block.text, cap) }
  if (block.type === 'tool-call') return { ...block, arguments: shrinkText(block.arguments, cap) }
  if (block.type === 'tool-result') return { ...block, content: block.content.map((part) => shrinkBlock(part, cap)) } as ContentBlock
  return block
}

/**
 * The region to summarize, cut down until the summarization request fits the window. Overflow recovery
 * summarizes everything at once — measured 2026-10-16: after a 10k-token report the whole region no longer
 * fit, the summary request itself was rejected, and the turn ended on the original overflow error. Long
 * blocks (printed tables, a report in a call's arguments) lose their middle first; short ones stay whole.
 */
export function fitMessages(messages: readonly Message[], budgetTokens: number): readonly Message[] {
  let shrunk = messages
  for (let cap = 8000; charsToTokens(JSON.stringify(shrunk)) > budgetTokens && cap >= 200; cap = Math.floor(cap / 2)) {
    shrunk = messages.map((message) => ({ ...message, content: message.content.map((block) => shrinkBlock(block, cap)) }) as Message)
  }
  return shrunk
}

export default class DataAnalysisCompaction extends BasicCompactionEngine {
  protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    // `compaction` is one service per runtime (a preset cannot register its own), so this engine is
    // the profile's only one: other flows keep the default coding-assistant summary.
    // (the default summarizer is the same single llm.stream call, i.e. the local SummaryResult shape)
    if (!input.system?.includes(WORKSPACE_HEADING)) return super.summarize(input, agent, signal) as Promise<SummaryResult>
    const configured = this.config.summarizationProvider.length > 0
      ? { provider: this.config.summarizationProvider, model: this.config.summarizationModel }
      : undefined
    const fallback = agent.options.provider && agent.options.model ? { provider: agent.options.provider, model: agent.options.model } : undefined
    const target = configured ?? agent.session.requestHeader()?.config ?? fallback
    if (target === undefined) throw new Error('no provider/model available for summarization')

    const window = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
    const messages = window === undefined ? input.messages : fitMessages(input.messages, window - this.config.maxTokens - charsToTokens(JSON.stringify(input.system ?? '') + JSON.stringify(input.tools ?? []) + INSTRUCTION))
    const instruction = createUserMessage({ content: [{ type: 'text', text: INSTRUCTION }], source: { kind: 'plugin', plugin: 'fox-harness-compaction-data-analysis' } })
    const assembler = new BlockAssembler()
    const stream = this.ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      messages: [...messages, instruction],
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    })
    for await (const chunk of stream) assembler.push(chunk)

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
    if (finish.kind === 'max-tokens') throw new Error('summarization truncated at the token cap (incomplete checkpoint)')
    const rawOutput = assembler.blocks()
    const summary = rawOutput.filter((block) => block.type === 'text')
    if (!summary.some((block) => block.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens: this.config.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }
}
