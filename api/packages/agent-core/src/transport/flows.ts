import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-tools'


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
//   {allow}    -> every global tool is hidden except these (meta-ads: todo_write).
// `read_image` is hidden everywhere: the openai-compat adapter sends the model text only, so the call always
// failed — with an attached image the model first tried it, got an error, then fell back to bash/python
// (docs/chat-attachments-plan.md). Back when image input is wired through.
const NO_IMAGE_INPUT = ['read_image']
const FLOW_TOOL_MASK: Record<string, 'all' | readonly string[] | { allow: readonly string[] }> = {
  // str_replace_editor duplicates `edit` (docs/file-tools-plan.md D3): two edit tools cost prompt and the model mixes them.
  default: [...NO_IMAGE_INPUT, 'str_replace_editor'],
  'data-studio': 'all',
  // docs/meta-ads-mcp-plan.md: Meta's tools (the preset) and a todo list; no files, shell, web or subagents
  'meta-ads': { allow: ['todo_write'] },
  'data-analysis': [
    'bash', 'str_replace_editor', 'job_kill', 'job_list', 'job_output', 'workflow', 'ralph',
    'subagent', 'subagent_fork', 'list_agents', 'interrupt_agent', 'send_message',
    'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'todo_write', ...NO_IMAGE_INPUT,
    // QA 2026-10-16: the model used `edit` to patch a canvas file in place, so the panel never got the new
    // version (canvas_write makes versions). `write` and python cover every other file change here.
    'edit',
  ],
}

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
  const mask = FLOW_TOOL_MASK[flow]
  if (mask !== undefined) {
    const globalTools = ctx.tools.schemas().map((schema) => schema.name)
    const deny =
      mask === 'all' ? globalTools
      : 'allow' in mask ? globalTools.filter((name) => !mask.allow.includes(name))
      : globalTools.filter((name) => mask.includes(name))
    if (deny.length > 0) agentCtx.tools.restrict({ deny })
    // A hidden tool's plugin still adds its usage section ("tool:<name>") to the system prompt. Measured
    // 2026-10-16 (data-analysis, 24k window): ~2,300 characters about bash, jobs, goals, workflow and ralph,
    // none of which the model can call, sent on every request. A scoped section shadows the global one
    // with the same name, and an empty section is dropped.
    const sections = new Set(deny.map((tool) => (tool.startsWith('job_') ? 'tool:jobs' : tool.endsWith('_goal') ? 'tool:goal' : `tool:${tool}`)))
    for (const section of sections) agentCtx.systemPrompt.section({ name: section, order: 100, text: '' })
  }
}
