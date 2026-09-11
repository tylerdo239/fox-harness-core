import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

import { FoxHarnessAgent } from './agent.ts'

/**
 * The loop's `AgentFactory`, replacing `@deepseek-ai/dsh-agent-loop` (roadmap
 * §0.2, "nấc 2"). A plain class, not a Cordis `Service` — nothing here needs
 * to be addressable as `ctx.agentLoop`; the only real requirement is being
 * registered through `ctx.agents.setFactory()` (done in index.ts).
 *
 * Minimal legal creation transaction per the real reference implementation
 * (`dsh-agent-loop`'s `index.ts`): `prepare()` + `enter()` + `announce()`
 * folded into one `ctx.effect()` so a fiber unload tears session + agent down
 * as one ordered chain, not racing siblings (see `SessionStore.prepare()`'s
 * own doc comment for why the `create()` shortcut is wrong for this case).
 *
 * Deliberately NOT ported from the reference for v1 (see this package's
 * README): concurrent create/resume/dispose race handling
 * (`FactoryOwnership`), the declarative `config.agents` boot-time array.
 *
 * **`this.ctx` vs. `ownerCtx` — confirmed the hard way.** `ownerCtx` (the
 * caller-bound context `AgentRegistry.create()` passes in) is NOT
 * necessarily injected for the services this factory needs — a real headless
 * run threw `cannot get property "sessions" without inject` from
 * `ownerCtx.sessions`, even though this plugin's own `inject` (index.ts)
 * lists `sessions`. Cordis's inject gate is per-ctx, not per-plugin: only
 * `this.ctx` (captured from this plugin's own `apply(ctx)`, which DID
 * declare the right injects) is guaranteed unlocked. `ownerCtx` is real and
 * meaningful — it carries the caller's fiber/scope for ownership — but every
 * *service* access here must go through `this.ctx`.
 */
export class FoxHarnessAgentLoop implements AgentFactory {
  constructor(private readonly ctx: Context) {}

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const session = this.ctx.sessions.prepare(options.sessionId, {
      seed: options.seed,
      meta: options.meta,
    })
    return this.enterAndAnnounce(ownerCtx, session, options.agentOptions ?? {})
  }

  // Phase 3 (hibernate/rehydrate): load a persisted session back off disk in
  // a FRESH process that never saw it created — this is the one thing that
  // makes rehydrating a killed container possible at all. `prepare()` reuses
  // object graphs from an earlier `inspect()` when the durable revision is
  // still current, and returns the exact same kind of unpublished `Session`
  // `createAgent()` gets from `ctx.sessions.prepare()` — so publication below
  // is identical between the two paths. The preparation must be disposed
  // after use (its own doc comment: disposal is a no-op once publication has
  // consumed it, but matters on the rollback/throw path — a failed setup
  // below must release the reservation, not leak it).
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const preparation = await this.ctx.sessionPersistence.prepare(options.resumeSessionId, options.signal)
    try {
      return await this.enterAndAnnounce(ownerCtx, preparation.session, options.agentOptions ?? {})
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  private async enterAndAnnounce(
    ownerCtx: Context,
    session: Session,
    agentOptions: NonNullable<CreateAgentOptions['agentOptions']>,
  ): Promise<AgentHandle> {
    // The agent's own `.ctx` is this factory's well-injected ctx too — not
    // ownerCtx — for the same reason: agent.ts's runStep() touches
    // ctx.systemPrompt/ctx.llm/ctx.tools, none of which ownerCtx is
    // guaranteed to have unlocked.
    const agent = new FoxHarnessAgent(this.ctx, session, agentOptions)

    const detachSession = this.ctx.sessions.enter(session)
    const detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
    this.ctx.sessions.announce(session)
    this.ctx.agents.announce(agent)

    const dispose = async () => {
      await agent.disposeGracefully()
      detachAgent()
      detachSession()
    }

    return { agent, dispose }
  }
}
