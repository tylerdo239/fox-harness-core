import type { Context } from '@deepseek-ai/cordis'
import {
  agentEvents,
  assembleContextFor,
  Inbox,
  type Agent,
  type AgentEventDispatch,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type PreStepDecision,
  type RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import type { InboxTarget } from '@deepseek-ai/dsh-agent/types'
import {
  canonicalHeader,
  headerEquals,
  type AgentCancelCause,
  type Session,
  type SessionId,
  type TurnEndReason,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  BlockAssembler,
  createToolResultMessage,
  LlmError,
  markAgentLoopRequest,
  type AssistantMessage,
  type GenerateOptions,
  type LlmCallConfig,
  type PreparedLlmCall,
} from '@deepseek-ai/dsh-llm'
/**
 * Real turn/step state machine, reimplemented from scratch by reading
 * @deepseek-ai/dsh-agent-loop's actual source (not guessed) — see
 * docs/code-rules.md §3 for the event contract this must satisfy, and this
 * package's README for exactly which parts are deliberately scoped down vs.
 * the reference implementation.
 *
 * Deliberate scope cuts for v1 (documented, not accidental):
 *  - Tool calls execute sequentially, never in parallel.
 *  - No `RuntimeContextProjection` snapshot message.
 *  - `cancel()` aborts the in-flight turn but does not distinguish
 *    aborted-before-dispatch from aborted-after-dispatch tool state the way
 *    upstream's `TOOL_ABORTED` / `TOOL_ABORTED_BEFORE_DISPATCH` do.
 *  - `runMaintenance()` does not truly exclude a concurrent turn from
 *    starting — it only refuses to run while one is already active.
 * None of these affect the DURABLE event contract's correctness; they trade
 * away concurrency/retry sophistication the reference implementation has.
 */
export class FoxHarnessAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: Inbox
  readonly ctx: Context

  private _status: AgentStatus = 'idle'
  private readonly dispatch: AgentEventDispatch
  private turnSeq = 0
  private requestHeaderLogged = false
  private driving = false
  private currentAbort: AbortController | undefined
  private idleWaiters: Array<() => void> = []

  constructor(ctx: Context, session: Session, options: AgentOptions) {
    this.ctx = ctx
    this.session = session
    this.id = session.id
    this.options = options
    // Built once and reused — dispatch.ts's own doc says repeat dispatchers
    // (a loop driver) should build this in the constructor, not per-call.
    this.dispatch = agentEvents(ctx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => this.dispatch.emit('agent/inbox/inserted', { message }),
      discarded: (message) => this.dispatch.emit('agent/inbox/discarded', { message }),
      claimed: (message, turn) => this.dispatch.emit('agent/inbox/claimed', { message, turn }),
    })
  }

  get status(): AgentStatus {
    return this._status
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.inbox.append(target, message)
    if (wakeup) this.wake()
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    this.currentAbort?.abort(cause)
    if (!options?.keepInbox) this.inbox.clear()
  }

  async whenIdle(): Promise<void> {
    if (!this.driving) return
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.driving) {
      throw new Error('fox-harness-agent-driver: cannot run maintenance while a turn is driving')
    }
    const controller = new AbortController()
    return task(controller.signal)
  }

  /** Called by the factory right before disposing the agent (see factory.ts). */
  async disposeGracefully(): Promise<void> {
    this.cancel({ kind: 'disposed' } as AgentCancelCause, { keepInbox: true })
    await this.whenIdle()
  }

  private wake(): void {
    if (this.driving) return
    this.driving = true
    this._status = 'running'
    this.dispatch.emit('agent/status', { status: 'running' })
    void this.drive().finally(async () => {
      this.driving = false
      this._status = 'idle'
      this.dispatch.emit('agent/status', { status: 'idle' })
      // Real, confirmed gap (Phase 3's kill -9 + rehydrate test, not a
      // hypothetical): dsh-session-checkpoint-policy's own doc comment says
      // it checkpoints a response/result batch at "the next request
      // boundary" — i.e. lazily, deferred until a FOLLOWING turn starts. A
      // session's most recent turn, with no follow-up yet, is genuinely
      // unflushed on disk even though `session/event` already notified live
      // subscribers (that event fires post-COMMIT, not post-FLUSH — commit
      // and flush are different guarantees). A hard kill right after loses
      // it. dsh-headless's own real source (lib/index.js) hits the same gap
      // and explicitly does `await agent.whenIdle(); await
      // sessions.flush(agent.session)` before exiting — same fix, applied
      // here instead of leaving every future `whenIdle()` caller to
      // remember it themselves.
      try {
        await this.ctx.sessions.flush(this.session)
      } catch (error) {
        this.dispatch.emit('agent/error', { turn: this.turnSeq, step: 0, error })
      }
      const waiters = this.idleWaiters.splice(0)
      for (const resolve of waiters) resolve()
    })
  }

  private async drive(): Promise<void> {
    while (await this.turn()) {
      // keep opening turns while the inbox still has pending work
    }
  }

  /** Runs exactly one turn. Returns whether the driver should open another. */
  private async turn(): Promise<boolean> {
    const turn = ++this.turnSeq
    const abort = new AbortController()
    this.currentAbort = abort
    this.session.append('turn/start', { turn })

    let step = 0
    let closed = false
    let reason: TurnEndReason = { kind: 'completed' }

    try {
      // Outer loop: re-enter step-claiming after `agent/turn-stopping` if a
      // listener steered during it (dsh-agent's own doc comment on
      // 'agent/turn-stopping': "a listener that objects steers ... and the
      // machine re-reads its inbox: fresh steering runs another step").
      for (;;) {
        while (!closed || this.inbox.nextStep.length > 0) {
          step += 1
          const claimed =
            step === 1
              ? [...this.inbox.claim('next-turn', turn), ...this.inbox.claim('next-step', turn)]
              : this.inbox.claim('next-step', turn)

          const decision = await this.dispatch.waterfall(
            'agent/pre-step',
            { messages: claimed, turn, step, signal: abort.signal },
            async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: claimed }),
          )

          if (decision.kind === 'reject') {
            closed = true
            reason = { kind: 'blocked' }
            break
          }

          this.session.append('step/start', { turn, step })
          try {
            for (const message of decision.messages) {
              this.session.append('user/message', message, { surfaceOp: 'append' })
            }
            const outcome = await this.runStep(turn, step, abort.signal)
            closed = outcome.concludesTurn || !outcome.hasToolCalls
          } finally {
            this.session.append('step/end', { turn, step })
          }
        }

        await this.dispatch.serial('agent/turn-stopping', { turn, signal: abort.signal })
        if (this.inbox.nextStep.length === 0) break
        closed = false // fresh steering arrived during turn-stopping — reopen
      }
    } catch (error) {
      reason = { kind: 'error', error: error instanceof LlmError ? error.failure : { message: String(error), code: 'UNKNOWN' } }
      this.dispatch.emit('agent/error', { turn, step, error })
    } finally {
      this.session.append('turn/end', { turn, reason })
      this.currentAbort = undefined
    }

    return this.inbox.hasPending
  }

  private async runStep(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<{ concludesTurn: boolean; hasToolCalls: boolean }> {
    const assembly = await this.ctx.systemPrompt.assemble(assembleContextFor(this, signal))
    const system = renderPrompt(assembly)
    const { assembler, config } = await this.callModel(turn, step, system, assembly.tools, signal)

    // BlockAssembler.message() returns the generic `Message` type; the
    // 'model' source tag is what actually makes it an AssistantMessage at
    // runtime (dsh-llm/message.ts's own createAssistantMessage does the same
    // narrowing implicitly). Asserting here mirrors that, not a type escape.
    const message = assembler.message({
      kind: 'model',
      provider: config.provider,
      model: config.model,
    }) as AssistantMessage
    // Same explicit-undefined pitfall as tool/result's error/meta below —
    // assembler.usage is undefined when the adapter reported none (not every
    // OpenAI-compatible server sends a usage chunk).
    this.session.append(
      'assistant/message',
      {
        turn,
        step,
        message,
        ...(assembler.usage !== undefined ? { usage: assembler.usage } : {}),
      },
      { surfaceOp: 'append' },
    )

    const toolCalls = assembler.blocks().filter((block) => block.type === 'tool-call')
    let concludesTurn = false

    // Sequential-only — deliberate v1 scope cut, see class doc comment.
    for (const call of toolCalls) {
      this.session.append('tool/call', {
        turn,
        step,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      })

      const result = await this.ctx.tools.execute({
        callId: call.id,
        name: call.name,
        arguments: JSON.parse(call.arguments || '{}'),
        agent: this,
        signal,
      })

      const resultMessage = createToolResultMessage({
        callId: call.id,
        content: result.content,
        isError: result.isError,
      })
      // `error`/`meta` are optional on SessionEventMap['tool/result'], but an
      // explicit `{ error: undefined }` is NOT the same as omitting the key —
      // dsh's session.append() rejects explicit `undefined` as
      // non-JSON-serializable (same real bug hit in translate.ts's
      // tool-call-delta — fixed there the same way). Confirmed the hard way:
      // this line threw on the very first successful real tool call.
      //
      // Second, DIFFERENT variant of the exact same bug class, found
      // 2026-09-10 (docs/code-rules.md): guarding on `result.isError` alone
      // isn't enough — `result.error.info` (dsh-tools's `errorInfo()`) is
      // ITSELF `undefined` whenever the tool's thrown error isn't a
      // `HarnessError` subclass (confirmed reading dsh-tools's real source:
      // `errorInfo()` returns `{name, code}` only for `error instanceof
      // HarnessError`, else `undefined`). Hit for real via
      // `dsh-sandbox`'s `approveEscalation()`, which throws a PLAIN `Error`
      // for its `"unavailable"` outcome (no approval channel configured —
      // this app never wires one up, by design, see docs/core-overview.md)
      // — that plain `Error` produces `result.error.info === undefined`,
      // and `error: undefined` crashed the whole turn exactly like the
      // first variant above. Guard both: only include `error` when
      // `result.error.info` is an actual value, not just when `result` is
      // an error at all.
      const toolResultPayload = {
        turn,
        step,
        message: resultMessage,
        ...(result.isError && result.error.info !== undefined ? { error: result.error.info } : {}),
        ...(result.meta !== undefined ? { meta: result.meta } : {}),
      }
      this.session.append('tool/result', toolResultPayload, { surfaceOp: 'append' })

      if (!result.isError && result.concludesTurn === true) concludesTurn = true
    }

    return { concludesTurn, hasToolCalls: toolCalls.length > 0 }
  }

  // A failed call is offered to `agent/request-error` listeners, as in
  // dsh-agent-loop: dsh-llm-retry backs off and answers `retry`,
  // compaction-basic compacts on context overflow. `retry` rebuilds the
  // request from the current session.
  private async callModel(
    turn: number,
    step: number,
    system: string,
    tools: GenerateOptions['tools'],
    signal: AbortSignal,
  ): Promise<{ assembler: BlockAssembler; config: LlmCallConfig }> {
    const defaultConfig: LlmCallConfig = {
      provider: this.options.provider ?? 'deepseek-official',
      model: this.options.model ?? 'deepseek-v4-flash',
      maxTokens: this.options.maxTokens,
    }

    for (;;) {
      const config = await this.dispatch.waterfall(
        'agent/request',
        { turn, step, signal },
        async () => defaultConfig,
      )

      const prepared = await this.ctx.llm.prepareCall(config, signal)
      this.logRequestHeader(prepared, system, tools)
      // The mark + sessionId are what dsh-session-title's model titler waits for.
      const request: GenerateOptions = markAgentLoopRequest({
        ...prepared.config,
        messages: this.session.deriveMessages(),
        system,
        tools,
        sessionId: this.session.id,
        signal,
      })

      const assembler = new BlockAssembler()
      for await (const chunk of prepared.stream(request)) {
        this.session.append('assistant/chunk', { turn, step, chunk })
        assembler.push(chunk)
      }

      const finish = assembler.finish
      if (finish.kind !== 'error' && finish.kind !== 'aborted') return { assembler, config }

      const action = await this.dispatch.waterfall(
        'agent/request-error',
        { turn, step, provider: prepared.config.provider, failure: finish.failure, retryPolicy: prepared.retryPolicy, signal },
        async (): Promise<RequestErrorAction> => undefined,
      )
      signal.throwIfAborted()
      if (action?.kind !== 'retry') throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
  }

  // Same bookkeeping as dsh-agent-loop's buildRequest: one header per agent
  // instance (`initial` on a new log, `resume` after a restart), later ones
  // only on change. dsh-session-title, dsh-token-meter and compaction read it.
  private logRequestHeader(prepared: PreparedLlmCall, system: string, tools: GenerateOptions['tools']): void {
    const header = canonicalHeader({
      config: prepared.config,
      adapterDefaults: prepared.adapterDefaults,
      ...(system ? { system } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
    })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }

    const { provider, model } = prepared.config
    const contextWindow = prepared.context?.contextWindow
    const previous = this.session.requestContext()
    if (previous?.provider !== provider || previous.model !== model || previous.contextWindow !== contextWindow) {
      this.session.append('request/context', { provider, model, ...(contextWindow !== undefined ? { contextWindow } : {}) })
    }
  }
}
