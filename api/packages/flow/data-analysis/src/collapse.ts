import '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'

// Plugin notes that belong to a turn's tool steps: the step-limit note (this package) and the
// Python variables note (@fox-harness/dsh-tool-python-repl).
const STEP_NOTE_PLUGINS = new Set(['fox-harness-flow-data-analysis', 'fox-harness-tool-python-repl'])
const ASSIGNMENT = /^([A-Za-z_]\w*)\s*=(?!=)/gm
/**
 * How much of a collapsed turn's tool output the note carries along.
 *
 * It used to carry none, and offered `print(history(n))` instead. Measured 2026-09-16: across 820
 * stored conversations that offer was made 271 times and taken 0 times, and in a chat built so that
 * a printed value existed ONLY inside a collapsed turn, the model neither fetched it nor recomputed
 * it — it stated a confident wrong number, the same one in both runs. A pointer the model never
 * follows is not a way of keeping information.
 *
 * Tail, not head, and this wide: measured over 70 tool outputs from 20 benchmark runs, 7 long
 * outputs contained the run's final answer — 6 of them within the last 300 characters, and the
 * seventh (a cell that printed three numbers and then a sample table) 550 from the end. Splitting
 * the same budget between head and tail scored WORSE (5 of 7): four of the six tail hits sit
 * 155-262 characters from the end, so halving the tail loses them. Widening the tail to 600 keeps
 * all seven. Collapsing is skipped entirely when the note is not smaller than what it replaces
 * (see collapseTurn), so a wider note costs context nowhere.
 */
const KEPT_OUTPUT_CHARS = 600

/**
 * Giai đoạn 6 A (docs/rlm-transfer-plan.md 12.3). Run at the end of a turn: every turn older than
 * the `keepRecentTurns` most recent has its tool steps replaced on the model-visible surface by a
 * one-line note — from its first tool-calling step (or step note) to its last tool result or the
 * step notes right after it, so the user's message and the final answer stay verbatim. The original events stay in the session log,
 * where `history(n)` reads them. As dsh-compaction-tool-result-pruner does, a `compaction/prune`
 * shadow price comes right before the replacement, so the token meter and threshold compaction
 * measure the smaller surface.
 *
 * Turn n is the n-th `turn/start` in the log, not `data.turn`: the driver restarts that at 1 when
 * a chat reopens.
 */
export function collapseOldTurns(session: Session, meter: TokenMeter, keepRecentTurns: number, plugin: string): void {
  let turn = 0
  const turnOf = session.events.map((event) => (event.type === 'turn/start' ? ++turn : turn))
  for (let n = 1; n <= turn - keepRecentTurns; n += 1) collapseTurn(session, meter, turnOf, n, plugin)
}

function collapseTurn(session: Session, meter: TokenMeter, turnOf: readonly number[], n: number, plugin: string): void {
  const { events } = session
  // A result the pruner rewrote belongs to the turn of the result it replaced.
  const turnOfNode = (seq: number): number => {
    const event = events[seq]!
    const origin = event.type === 'tool/result' && !isAppendSurfaceEvent(event) ? event.sourceEventSeqs?.[0] : undefined
    return turnOf[origin ?? seq]!
  }

  const nodes = session.surface.nodes
  let start = -1
  let end = -1
  nodes.forEach((seq, index) => {
    if (turnOfNode(seq) !== n) return
    const event = events[seq]!
    if (start === -1 && (isToolStep(event) || isStepNote(event))) start = index
    // A note added after the last tool result (the variables note of the answering step) goes too.
    if (event.type === 'tool/result' || (start !== -1 && end !== -1 && isStepNote(event))) end = index
  })
  if (start === -1 || end < start) return

  // Only this turn's tool steps and step notes, with every call answered inside the span.
  const span = nodes.slice(start, end + 1)
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const seq of span) {
    const event = events[seq]!
    if (turnOfNode(seq) !== n) return
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) if (block.type === 'tool-call') calls.add(block.id)
    } else if (event.type === 'tool/result') {
      results.add(event.data.message.content[0]!.toolCallId)
    } else if (!isStepNote(event)) {
      return
    }
  }
  if (calls.size !== results.size || [...calls].some((id) => !results.has(id))) return

  const shadowedTokenCount = meter.measure(session).nodes.slice(start, end + 1).reduce((total, node) => total + node.tokens, 0)
  const note = createUserMessage({ content: [{ type: 'text', text: collapsedNote(events, turnOf, n) }], source: { kind: 'plugin', plugin } })
  if (meter.estimateMessage(note) >= shadowedTokenCount) return
  const range = { start: span[0]!, end: span[span.length - 1]! }
  session.append('compaction/prune', { shadowedRange: range, shadowedSeqs: [...span], shadowedTokenCount })
  session.append('user/message', note, { surfaceOp: { op: 'replace', ...range }, sourceEventSeqs: [...span] })
}

function isToolStep(event: SessionEvent): boolean {
  return event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'tool-call')
}

function isStepNote(event: SessionEvent): boolean {
  return event.type === 'user/message' && isAppendSurfaceEvent(event) && event.data.source.kind === 'plugin' && STEP_NOTE_PLUGINS.has(event.data.source.plugin)
}

function collapsedNote(events: readonly SessionEvent[], turnOf: readonly number[], n: number): string {
  const counts = new Map<string, number>()
  const assigned = new Set<string>()
  let failed = 0
  events.forEach((event, seq) => {
    if (turnOf[seq] !== n) return
    if (event.type === 'tool/call') {
      counts.set(event.data.name, (counts.get(event.data.name) ?? 0) + 1)
      for (const match of codeOf(event.data.arguments).matchAll(ASSIGNMENT)) assigned.add(match[1]!)
    } else if (event.type === 'tool/result' && isAppendSurfaceEvent(event) && event.data.message.content[0]!.isError) {
      failed += 1
    }
  })
  const calls = [...counts].map(([tool, count]) => `${tool} ×${count}`).join(', ')
  const names = [...assigned].slice(0, 8)
  const tail = outputTail(events, turnOf, n)
  return (
    `[Turn ${n}: tool steps (${calls}${failed > 0 ? `, ${failed} failed` : ''}) collapsed to save context.` +
    (names.length > 0 ? ` Variables assigned: ${names.join(', ')}.` : '') +
    (tail ? ` Last output of the turn: ${tail}` : '') +
    ` Full code and output: print(history(${n})) in the python tool.]`
  )
}

/** End of what this turn's tools printed, so a value that was only printed survives the collapse. */
function outputTail(events: readonly SessionEvent[], turnOf: readonly number[], n: number): string {
  let text = ''
  events.forEach((event, seq) => {
    if (turnOf[seq] !== n || event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) return
    const block = event.data.message.content[0]!
    if (block.isError) return
    text += block.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
  })
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return ''
  return collapsed.length > KEPT_OUTPUT_CHARS ? `…${collapsed.slice(-KEPT_OUTPUT_CHARS)}` : collapsed
}

function codeOf(args: string): string {
  try {
    const code = (JSON.parse(args || '{}') as { code?: unknown }).code
    return typeof code === 'string' ? code : ''
  } catch {
    return '' // arguments the model left malformed; the note just lists no variables
  }
}
