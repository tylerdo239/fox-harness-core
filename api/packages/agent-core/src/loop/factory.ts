import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  AgentFactory,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { SessionPreparation, type Session } from '@deepseek-ai/dsh-session'

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
    const preparation = SessionPreparation.create(
      this.ctx.sessions.prepare(options.sessionId, {
        seed: options.seed,
        meta: options.meta,
      }),
    )
    try {
      return await this.setupAndPublish(ownerCtx, preparation.session, options.agentOptions ?? {}, options.setup, options.signal, 'startup')
    } finally {
      preparation[Symbol.dispose]()
    }
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
      return await this.setupAndPublish(ownerCtx, preparation.session, options.agentOptions ?? {}, options.setup, options.signal, 'resume')
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  /**
   * Build the agent (with its own scope), run the caller's `setup(agent.ctx)`
   * BEFORE the agent is visible anywhere, then publish — dsh-agent-loop's
   * `setupAndPublish` (lib/index.js:1250). `setup` is where an agent preset is
   * joined (`ctx.agentPresets.mount(agentCtx, id)`): registrations land in
   * this agent's scope, so a failed setup rolls everything back by disposing
   * that scope. Spike-level scope cuts vs. upstream (documented, not
   * accidental): no owner-fiber lifecycle effect and no factory-wide
   * ownership/teardown tracking (`FactoryOwnership`).
   */
  private async setupAndPublish(
    ownerCtx: Context,
    session: Session,
    agentOptions: NonNullable<CreateAgentOptions['agentOptions']>,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: 'startup' | 'resume',
  ): Promise<AgentHandle> {
    // The agent's loop ctx is this factory's well-injected ctx — not
    // ownerCtx — for the reason in the class comment above.
    const agent = new FoxHarnessAgent(this.ctx, session, agentOptions)

    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    // Memoized (as upstream): the owner, a failed publish and a caller can all
    // ask for it; teardown must run exactly once.
    const dispose = (): Promise<void> =>
      (disposing ??= (async () => {
        try {
          await agent.disposeGracefully()
        } finally {
          detachAgent?.()
          detachSession?.()
        }
      })())

    try {
      signal?.throwIfAborted()
      const commit = await raceAbort(setup?.(agent.ctx), signal)
      if (commit) commit.commit()
      signal?.throwIfAborted()

      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
      agent.ctx.sessions.announce(session)
      this.ctx.agents.announce(agent)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', { source })
      return { agent, dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}

/** Await `value`, rejecting early if `signal` aborts first (caller cancellation during setup). */
async function raceAbort<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return value
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('agent creation aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
