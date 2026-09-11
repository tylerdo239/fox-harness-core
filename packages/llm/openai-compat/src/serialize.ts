import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

/** OpenAI chat-completions wire message — the request-side shape only. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  // Without this, most OpenAI-compatible servers omit the terminal `usage`
  // object from the stream — confirmed against the real dsh-llm-deepseek
  // adapter, which sets the same flag (standard OpenAI flag, not
  // DeepSeek-specific).
  stream_options: { include_usage: true }
  tools?: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function serializeMessage(message: Message): WireMessage[] {
  if (message.role === 'assistant') {
    const toolCalls = message.content.filter((block) => block.type === 'tool-call')
    return [
      {
        role: 'assistant',
        content: textOf(message.content),
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      },
    ]
  }

  // A user-role message is either a plain prompt or a tool-result carrier
  // (docs/code-rules.md / ToolResultMessage: role 'user', content is exactly
  // one tool-result block). OpenAI's wire format wants tool results as
  // separate `role: 'tool'` messages, one per result — matches the real
  // dsh-llm-deepseek adapter's serialize.ts.
  const toolResults = message.content.filter((block) => block.type === 'tool-result')
  if (toolResults.length > 0) {
    return toolResults.map((result) => ({
      role: 'tool' as const,
      tool_call_id: result.toolCallId,
      content: textOf(result.content),
    }))
  }

  return [{ role: 'user', content: textOf(message.content) }]
}

export function serializeRequest(options: GenerateOptions): WireRequest {
  const messages: WireMessage[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    messages.push(...serializeMessage(message))
  }

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    tools: options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stop: options.stop,
  }
}
