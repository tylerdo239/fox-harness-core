// A minimal MCP client over Streamable HTTP (spec 2025-06-18), enough for a remote tool server: initialize, the
// initialized notification, tools/list, tools/call. The gateway is the only MCP client of the ad platforms
// (docs/meta-ads-mcp-plan.md D2) and must not import dsh, and @modelcontextprotocol/sdk is not installed here; the
// protocol needed is a few JSON-RPC POSTs, each answered with JSON or with an SSE stream that carries the reply.

const PROTOCOL_VERSION = '2025-06-18'

export class McpHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export class McpRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: Record<string, unknown>
}

export interface McpCallResult {
  content?: { type: string; text?: string; [key: string]: unknown }[]
  structuredContent?: unknown
  isError?: boolean
}

export class McpHttpClient {
  private sessionId: string | undefined
  private nextId = 1
  private ready: Promise<void> | undefined

  constructor(private readonly url: string, private readonly token: string, private readonly timeoutMs: number) {}

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.init(signal)
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {}, signal)) as { tools?: McpTool[]; nextCursor?: string }
      tools.push(...(result.tools ?? []))
      cursor = result.nextCursor
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    await this.init(signal)
    return (await this.request('tools/call', { name, arguments: args ?? {} }, signal)) as McpCallResult
  }

  async close(): Promise<void> {
    if (!this.sessionId) return
    // ends the server-side session; failure is irrelevant
    await fetch(this.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
    this.sessionId = undefined
  }

  private init(signal?: AbortSignal): Promise<void> {
    this.ready ??= (async () => {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'fox-agent', version: '1' },
      }, signal)
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal)
    })().catch((error: unknown) => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const reply = await this.post({ jsonrpc: '2.0', id, method, params }, signal, id)
    if (!reply || typeof reply !== 'object') throw new McpRpcError(-32603, `no reply to ${method}`)
    const message = reply as { result?: unknown; error?: { code?: number; message?: string } }
    if (message.error) throw new McpRpcError(message.error.code ?? -32603, message.error.message ?? 'MCP error')
    return message.result
  }

  private async post(body: unknown, signal: AbortSignal | undefined, id?: number): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const session = response.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 300)
      // a session the server forgot: start over on the next call
      if (response.status === 404 && this.sessionId) {
        this.sessionId = undefined
        this.ready = undefined
      }
      throw new McpHttpError(response.status, text || response.statusText)
    }
    if (id === undefined) {
      await response.body?.cancel()
      return undefined
    }
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) return readSseReply(response, id)
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }
}

/** The JSON-RPC message answering `id` out of an SSE stream (other messages on it — notifications — are skipped). */
async function readSseReply(response: Response, id: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: true })
      let cut: number
      while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, cut)
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '')
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const message = JSON.parse(data) as { id?: unknown }
        if (message.id === id) return message
      }
      if (done) return undefined
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
