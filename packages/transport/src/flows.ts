import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-tools'

import { workspaceGuard } from './workspace-guard.ts'

// A "flow" (default / data-analysis / data-studio) is an agent preset
// (`@deepseek-ai/dsh-agent-presets`, docs/single-backend-architecture-plan.md §3):
// one runtime hosts agents of every flow, each joined to its own preset, so
// its tools, persona and listeners are scoped to that agent.
//
// Per-flow mask over the GLOBAL tool layer (`tools.restrict()` only filters global tools; the
// preset's own scoped registrations stay visible). This is what the per-flow `disabled: true`
// rows in profile-template/<flow>/cordis.patch.yml did when a flow was a whole process.
//   'all'      -> the flow's tools come ONLY from its preset (data-studio: `analyze_data`).
//   string[]   -> these global tools are hidden, the rest stay (data-analysis: no bash, no subagents...).
const FLOW_TOOL_MASK: Record<string, 'all' | readonly string[]> = {
  'data-studio': 'all',
  'data-analysis': [
    'bash', 'str_replace_editor', 'job_kill', 'job_list', 'job_output', 'workflow', 'ralph',
    'subagent', 'subagent_fork', 'list_agents', 'interrupt_agent', 'send_message',
    'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'todo_write',
  ],
}

const sharedReadDirs = (process.env.FOX_SHARED_READ_DIRS ?? '').split(':').filter(Boolean)

export const FLOW_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * `AgentSetup` body: runs before the agent is published, with the agent's own
 * scoped ctx. A throw here aborts the creation and rolls the scope back.
 */
export async function joinFlow(ctx: Context, agentCtx: Context, flow: string): Promise<void> {
  // `ctx.get`, not `ctx.agentPresets`: Cordis has no optional inject, and a
  // profile without the `agent-presets` row (the per-session-container
  // profiles) must keep working — it simply has no flows to join.
  const presets = ctx.get('agentPresets')
  if (!presets) {
    if (flow === 'default') return
    throw new Error(`flow "${flow}" requested but this runtime has no agent-presets row`)
  }
  await presets.mount(agentCtx, flow)
  // Every agent, whatever its flow: its tools may only touch its own workspace
  // (plus FOX_SHARED_READ_DIRS, read-only). Registered through the agent's own
  // ctx, so it applies to this agent alone.
  agentCtx.tools.guard(workspaceGuard(sharedReadDirs))
  const mask = FLOW_TOOL_MASK[flow]
  if (mask !== undefined) {
    const globalTools = ctx.tools.schemas().map((schema) => schema.name)
    const deny = mask === 'all' ? globalTools : globalTools.filter((name) => mask.includes(name))
    if (deny.length > 0) agentCtx.tools.restrict({ deny })
  }
}
