import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import '@deepseek-ai/dsh-agent'

// Phase 6 checklist item 1: "Quota: token ... theo user." Tracks budget per
// SESSION, not per user — real user identity DOES exist now (Phase 7's
// `users` table), but this file has no way to reach it (worker processes
// never talk to the database directly, roadmap §1.2: "worker không biết gì về
// multi-tenant") without giving it a store connection it has no other
// reason to hold, so per-session stays the deliberate v1 scope. Lives
// in-worker, not control-plane, because token usage is only ever
// known here, in real time, as `dsh-core`'s own `agent/request` listener
// (index.ts) and the LLM adapter actually make the call — reporting it back
// out to Redis/MariaDB would mean giving the worker a store connection it
// has no other reason to hold (roadmap §1.2: "worker không biết gì về
// multi-tenant"). Accepted consequence, not hidden: this counter lives only
// in this process's memory, so it resets on hibernate/rehydrate — a session
// that hibernates right at its budget can get a fresh budget after
// rehydrating. A real fix would replay `assistant/message.usage` from the
// session log on boot to reconstruct the running total (the same
// log-is-truth principle, roadmap §0.4); out of scope for this pass, same
// "documented gap, not silently accepted" discipline as every other known
// limitation in this project (see docs/code-rules.md).
const usedTokensBySession = new Map<string, number>()

export function apply(ctx: Context) {
  // Always track usage, even with no budget configured — makes the counter
  // available for future use (e.g. a future `/quota` inspection endpoint)
  // without needing SESSION_TOKEN_BUDGET set.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const usage = (event.data as { usage?: { inputTokens: number; outputTokens: number } }).usage
    if (!usage) return
    const total = usage.inputTokens + usage.outputTokens
    usedTokensBySession.set(session.id, (usedTokensBySession.get(session.id) ?? 0) + total)
  })

  const raw = launchEnvironmentOf(ctx).get('SESSION_TOKEN_BUDGET')?.value
  const budget = raw ? Number(raw) : undefined
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return // unset/invalid = no limit

  // `agent/pre-step` is the real gate the turn/step machine already exposes
  // for exactly this (roadmap §2.2's `reject | enter(messages)` waterfall,
  // packages/agent-driver/src/agent.ts's own `turn()` honors it verbatim).
  // A reject closes the turn with `reason: {kind: 'blocked'}`, which
  // packages/client-ui-conversation's existing event handler already
  // surfaces as a visible notice — no new FE plumbing needed for this to be
  // observable, it falls out of a mechanism Phase 2 already built.
  ctx.on('agent/pre-step', async (payload, next) => {
    const used = usedTokensBySession.get(payload.agent.id) ?? 0
    if (used >= budget) return { kind: 'reject' }
    return next()
  })
}
