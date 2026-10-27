import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

// Meta Ads tools (docs/meta-ads-mcp-plan.md). Each tool is one of Meta's ads MCP tools, with Meta's own name, text
// and input schema, but the call goes to the GATEWAY (FOX_INTERNAL_URL, loopback, runtime secret), never to Meta:
// the gateway holds each user's token, finds the session's owner, enforces the allow-list, and holds a write until the
// owner confirms it on the confirmation card. This process never sees a token.
//
// The tool list comes from the gateway too (GET /internal/meta-ads/tools): Meta's tools/list needs a user's token,
// so the gateway fetches it when someone connects and keeps it. Until then this plugin registers nothing and asks
// again every minute; a changed list replaces the registered set.

export const name = 'fox-harness-tool-meta-ads'
export const inject = ['tools', 'agents']

interface RemoteTool {
  name: string
  description: string
  inputSchema: unknown
  tier: 'read' | 'write'
  spends: boolean
}

type Outcome = { ok: true; text: string } | { ok: false; code: string; message: string }

const READ_TIMEOUT_MS = 90_000
// a write waits for the user's click (gateway META_ADS_CONFIRM_TIMEOUT_MS, 10 min) and then for Meta
const WRITE_TIMEOUT_MS = 12 * 60_000
const POLL_EMPTY_MS = 60_000
const POLL_MS = 10 * 60_000

const WRITE_NOTE =
  ' [Fox Agent: this changes the ad account. The user is shown a confirmation card and must approve it before ' +
  'anything is sent to Meta; if they decline or do not answer, the call fails and nothing changed. Call it only ' +
  'once the user has asked for this change, with the exact values they agreed to.]'
const SPEND_NOTE = ' Activating starts spending the budget.'

/**
 * The conversation's root session: the one the gateway knows (discovery_sessions) and whose owner's account is used.
 * A subagent's own session is not in the database; walk `parentSession` up, as data-studio-agent's ownerOf does.
 */
function rootSessionOf(ctx: Context, agent: Agent | undefined): string | undefined {
  let current = agent
  for (let hops = 0; current && hops < 16; hops += 1) {
    const parent = current.session.header.parentSession
    if (!parent) return current.session.id
    const next = ctx.agents.get(parent)
    if (!next) return parent
    current = next
  }
  return undefined
}

async function internal(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const base = process.env.FOX_INTERNAL_URL
  const secret = process.env.FOX_INTERNAL_SECRET
  if (!base || !secret) throw new Error('Meta Ads is unavailable: this runtime has no gateway callback configured')
  const timeout = AbortSignal.timeout(timeoutMs)
  return fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-fox-harness-internal-secret': secret, ...(init.headers ?? {}) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
}

function definitionOf(ctx: Context, tool: RemoteTool): ToolDefinition {
  const description = tool.tier === 'write' ? `${tool.description}${WRITE_NOTE}${tool.spends ? SPEND_NOTE : ''}` : tool.description
  return {
    name: tool.name,
    description,
    parameters: tool.inputSchema,
    timeoutMs: tool.tier === 'write' ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS,
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: unknown, exec: { agent?: Agent; callId: string; signal: AbortSignal }) {
      const sessionId = rootSessionOf(ctx, exec.agent)
      if (!sessionId) throw new Error('Meta Ads tools need a conversation')
      const response = await internal(
        '/internal/meta-ads/call',
        { method: 'POST', body: JSON.stringify({ sessionId, callId: exec.callId, tool: tool.name, arguments: typeof args === 'object' && args !== null ? args : {} }) },
        tool.tier === 'write' ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS,
        exec.signal,
      )
      if (!response.ok) throw new Error(`Meta Ads gateway error ${String(response.status)}`)
      const outcome = (await response.json()) as Outcome
      if (!outcome.ok) throw new Error(`[${outcome.code}] ${outcome.message}`)
      return { text: outcome.text }
    },
  } as unknown as ToolDefinition
}

export function apply(ctx: Context) {
  let registered = new Map<string, () => void>()
  let signature = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  async function sync(): Promise<void> {
    let tools: RemoteTool[] = []
    try {
      const response = await internal('/internal/meta-ads/tools', { method: 'GET' }, 15_000)
      if (response.ok) tools = ((await response.json()) as { tools?: RemoteTool[] }).tools ?? []
    } catch (error) {
      ctx.logger.warn(`meta-ads: tool list unavailable: ${String(error)}`)
    }
    const next = JSON.stringify(tools)
    if (next !== signature && !stopped) {
      for (const dispose of registered.values()) dispose()
      registered = new Map()
      for (const tool of tools) {
        try {
          registered.set(tool.name, ctx.tools.register(definitionOf(ctx, tool)))
        } catch (error) {
          ctx.logger.error(`meta-ads: could not register ${tool.name}: ${String(error)}`)
        }
      }
      signature = next
      ctx.logger.info(`meta-ads: ${String(registered.size)} tools registered`)
    }
    if (!stopped) timer = setTimeout(() => void sync(), tools.length === 0 ? POLL_EMPTY_MS : POLL_MS)
  }

  void sync()
  ctx.effect(() => () => {
    stopped = true
    if (timer) clearTimeout(timer)
    for (const dispose of registered.values()) dispose()
    registered = new Map()
  }, 'fox-harness-tool-meta-ads.sync')
}
