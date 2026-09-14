import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import '@deepseek-ai/dsh-agent'

import { apply as applyPrompt } from './prompt.ts'
import { apply as applyQuota } from './quota.ts'

export const name = 'fox-harness-core'
export const inject = ['systemPrompt']

// Composition root for our product-specific components. Each component is
// its own file under src/components/ once Phase 0's real --dump-config run
// tells us which of the ~90 dsh-base rows we're actually replacing vs. adding
// to (docs/code-rules.md §0.1 — do not invent a component list before that).
export function apply(ctx: Context) {
  // Route model selection from OPENAI_MODEL_ID (roadmap: user wants exactly
  // 3 env vars — OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL_ID — to fully
  // control which provider/model is used, no cordis.patch.yml edits needed
  // for a normal deploy). This is a real extension point, not a guess: the
  // `agent/request` waterfall is dispatched by our own agent-driver
  // (packages/agent-driver/src/agent.ts) precisely so other plugins can
  // override the call config here rather than the driver hardcoding it —
  // registering via `ctx.on()` at root scope (not agent-scoped) means every
  // agent gets this override, matching "agent-scoped listeners receive only
  // that agent" vs. a plain root listener receiving all of them.
  ctx.on('agent/request', async (payload, next) => {
    const model = launchEnvironmentOf(ctx).get('OPENAI_MODEL_ID')?.value
    if (!model) return next()
    return { provider: 'openai-compat', model }
  })

  // Phase 6 checklist item 1: per-session token budget. See quota.ts for why
  // this is session-scoped (no real user identity yet) and in-worker (only
  // place real-time usage is visible).
  applyQuota(ctx)

  // Default chat instructions + today's date (prompt.ts).
  applyPrompt(ctx)
}
