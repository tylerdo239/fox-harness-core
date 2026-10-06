import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-session'

import { startTransportServer } from './server.ts'
import { workspaceGuard } from './workspace-guard.ts'

export const name = 'fox-harness-transport'
// Follow-up (2026-09-08): 'clientManifest' removed — that service
// (packages/agent-core/src/policy/client-manifest.ts) no longer exists, along with the
// whole per-session UI-plugin delivery mechanism it backed (see
// app/README.md). Requiring it here would have left this plugin
// PERMANENTLY pending (Cordis `inject` waits for every named service to
// exist), a real bug caught by grepping for leftover references after the
// removal, not by a failing test.
export const inject = ['agents', 'sessions', 'tools']

export interface Config {
  /** WebSocket bind port for the event stream + command endpoint. */
  port: number
  /** WebSocket bind host. */
  host: string
}

export const Config: z<Config> = z.object({
  port: z.number().default(4001).description('WebSocket port for the event stream + command endpoint.'),
  host: z.string().default('127.0.0.1').description('Bind host.'),
})

// Exposes the event stream + command endpoint that services/gateway proxies
// to browsers (roadmap Phase 2, step 1). This is our own transport, layered
// on top of the harness process — it is NOT Typert (docs/code-rules.md §0.3):
// Typert is upstream's in-process Host<->Client RPC and explicitly excludes
// streaming protocols like session/event from its Remote method model.
// Wire protocol + verified log-before-fanout guarantee: see server.ts.
export function apply(ctx: Context, config: Config) {
  // One runtime process per shard (services/gateway's supervisor starts K of them from ONE profile),
  // so port/host cannot live only in the profile's patch file: the supervisor sets them per process.
  const port = process.env.FOX_TRANSPORT_PORT ? Number(process.env.FOX_TRANSPORT_PORT) : config.port
  const host = process.env.FOX_TRANSPORT_HOST ?? config.host
  ctx.effect(() => startTransportServer(ctx, port, host), 'fox-harness-transport.server()')
  // ONE guard for every agent in this process — top-level agents AND the subagents they spawn (which do
  // not share their parent's scope): a tool call whose path leaves the calling session's own workspace is
  // refused. FOX_SHARED_READ_DIRS (the built-in skills) stay readable.
  const sharedReadDirs = (process.env.FOX_SHARED_READ_DIRS ?? '').split(':').filter(Boolean)
  ctx.effect(() => ctx.tools.guard(workspaceGuard(sharedReadDirs)), 'fox-harness-transport.workspace-guard')
}
