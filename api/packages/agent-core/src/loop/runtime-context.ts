import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent, type Session } from '@deepseek-ai/dsh-session'

// Port of dsh-agent-loop's RuntimeContextProjection (lib/types/runtime-context.js, 0.1.1-rc.2 — not exported).
// dsh-system-prompt's dynamic CONTEXTS (file policy, sandbox state, ... — anything a plugin registers as a context
// rather than a system-prompt section) reach the model as a "Current runtime context" user message, appended to a
// step's messages only when the rendered snapshot differs from the last one the log still carries. Without it the
// model never saw them: measured with a parity run against dsh-agent-loop on the same scripted conversation.

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

interface SourcedMessage {
  source: { kind: string; plugin?: string }
  content: readonly { type: string; text?: string }[]
}

function isOwned(message: SourcedMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function textOf(message: SourcedMessage): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

export class RuntimeContextProjection {
  /** `undefined`: no snapshot ever existed; `null`: none is retained. */
  private retained: { seq: number; text: string | undefined } | null | undefined

  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event?.type !== 'user/message' || !isOwned(event.data as SourcedMessage)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data as SourcedMessage) }
        break
      }
    }
    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data as SourcedMessage)) {
        this.retained = { seq: event.seq, text: textOf(event.data as SourcedMessage) }
      } else if (this.retained && isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }

  /** A candidate user message when the current snapshot differs from the retained one, else `undefined`. */
  project(current: string, sections: readonly { name: string; text: string }[]): Message | undefined {
    if (this.retained === undefined && current.length === 0) return undefined
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return undefined
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      source: sections.length === 0 ? { kind: 'plugin', plugin: SOURCE } : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
    } as Parameters<typeof createUserMessage>[0])
  }
}
