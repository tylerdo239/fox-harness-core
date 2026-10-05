import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-persistence'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-tools'

import { FoxHarnessAgentLoop } from './factory.ts'

export const name = 'fox-harness-agent-driver'

// Cordis guards named context services behind an explicit `inject`
// declaration — confirmed the hard way: booting without this threw "cannot
// get property 'agents' without inject" the moment apply() touched
// ctx.agents, even though `agents` is a plain plugin property here, not a
// Service class needing this on `static inject`. A real headless run (the
// first time createAgent() ever actually ran — a plain web boot never
// exercises this path without a real browser session) then hit the same
// error for 'sessions' — and would have for 'systemPrompt'/'llm'/'tools'
// too, since factory.ts passes THIS ctx (not the caller's ownerCtx) into
// FoxHarnessAgent, and agent.ts's runStep() touches all three. Listing every
// service either file touches here, once, is what makes that safe.
// 'sessionPersistence' added for Phase 3's resume() (factory.ts) — same rule,
// same failure mode if omitted.
export const inject = ['agents', 'sessions', 'sessionPersistence', 'systemPrompt', 'llm', 'tools']

// Replaces the default `core/agent-loop` row (nấc 2, roadmap §0.2). Row id
// this patches is `agent-loop`, verified real via a live `dsh --profile web
// --dump-config` run (docs/code-rules.md §0.1) — see cordis.patch.yml.
export function apply(ctx: Context) {
  const factory = new FoxHarnessAgentLoop(ctx)
  ctx.effect(() => ctx.agents.setFactory(factory), 'fox-harness-agent-driver.setFactory()')

  // Swapping out core/agent-loop drops more than the turn/step loop — the
  // reference implementation also registers these 3 prompt template
  // variables (verified: dsh-agent-loop's real src/index.ts:421-423). Without
  // them, the real system-prompt row's `{{model}}`/`{{cwd}}` persona
  // template throws "unknown prompt variable" — confirmed the hard way on a
  // real headless run. `provider` isn't used by the shipped persona template
  // but is registered anyway to match the real contract other prompt
  // sections may rely on.
  ctx.systemPrompt.variable('provider', (context) => context.agent?.options.provider)
  ctx.systemPrompt.variable('model', (context) => context.agent?.options.model)
  ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)
}

export { FoxHarnessAgent } from './agent.ts'
export { FoxHarnessAgentLoop } from './factory.ts'
