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
                function: { name: call.name, arguments: sendableArguments(call.arguments) },
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

/**
 * A tool call's arguments as the server will accept them.
 *
 * The model sometimes stops mid-argument — its output is cut off and what reaches the session is
 * a half-written `{"code": "..."` with no closing brace. Sent back on the next request, vLLM
 * rejects the whole conversation with `400 ... Expecting ',' delimiter: line 1 column 109`, and
 * since every later request carries that same message again, the chat can never recover: measured
 * on a real run, 2026-09-16, where four turns in a row died on the same character position.
 * An unparseable argument string is replaced with an empty object here, at the wire boundary, so
 * one truncated call costs that call and not the conversation. The session log keeps the original.
 */
function sendableArguments(args: string): string {
  if (args === '') return args
  try {
    JSON.parse(args)
    return args
  } catch {
    return '{}'
  }
}
