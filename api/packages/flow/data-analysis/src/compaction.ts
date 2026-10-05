import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, createUserMessage, type ContentBlock, type Message, type TokenUsage, type ToolSchema } from '@deepseek-ai/dsh-llm'

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
  '- rules the user set for the rest of the conversation (answer format, rounding, language, a required closing line, things to avoid), quoted exactly; never drop one, however old',
  '## Requests',
  '- every user request in order, marked answered or still open; quote exact wording where it matters',
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
export default class DataAnalysisCompaction extends BasicCompactionEngine {
  protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const configured = this.config.summarizationProvider.length > 0
      ? { provider: this.config.summarizationProvider, model: this.config.summarizationModel }
      : undefined
    const fallback = agent.options.provider && agent.options.model ? { provider: agent.options.provider, model: agent.options.model } : undefined
    const target = configured ?? agent.session.requestHeader()?.config ?? fallback
    if (target === undefined) throw new Error('no provider/model available for summarization')

    const instruction = createUserMessage({ content: [{ type: 'text', text: INSTRUCTION }], source: { kind: 'plugin', plugin: 'fox-harness-compaction-data-analysis' } })
    const assembler = new BlockAssembler()
    const stream = this.ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      messages: [...input.messages, instruction],
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
