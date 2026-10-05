import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

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
// Usage is read from the session's own durable log (`assistant/message.usage`), cached per
// Session object. Two things this fixes over the old process-wide `Map<sessionId, number>`:
//  - it never reset: with idle disposal (one runtime hosting many sessions) a session that is
//    disposed and resumed gets a NEW Session object, whose total is rebuilt from the log instead
//    of starting again at 0 — the budget survives hibernate/resume, closing the gap documented
//    here earlier;
//  - it never leaked: a WeakMap entry dies with its Session.
const usedBySession = new WeakMap<Session, number>()

function usageOf(event: { type: string; data: unknown }): number {
  if (event.type !== 'assistant/message') return 0
  const usage = (event.data as { usage?: { inputTokens: number; outputTokens: number } }).usage
  return usage ? usage.inputTokens + usage.outputTokens : 0
}

function usedTokens(session: Session): number {
  let used = usedBySession.get(session)
  if (used === undefined) {
    used = 0
    for (const event of session.events) used += usageOf(event)
    usedBySession.set(session, used)
  }
  return used
}

export function apply(ctx: Context) {
  // Keep a cached total current as new messages are logged.
  ctx.on('session/event', (session, event) => {
    const cached = usedBySession.get(session)
    if (cached !== undefined) usedBySession.set(session, cached + usageOf(event))
  })

  const raw = launchEnvironmentOf(ctx).get('SESSION_TOKEN_BUDGET')?.value
  const budget = raw ? Number(raw) : undefined
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return // unset/invalid = no limit

  // `agent/pre-step` is the real gate the turn/step machine already exposes
  // for exactly this (roadmap §2.2's `reject | enter(messages)` waterfall,
  // packages/agent-driver/src/agent.ts's own `turn()` honors it verbatim).
  // A reject closes the turn with `reason: {kind: 'blocked'}`.
  ctx.on('agent/pre-step', async (payload, next) => {
    if (usedTokens(payload.agent.session) >= budget) return { kind: 'reject' }
    return next()
  })
}
