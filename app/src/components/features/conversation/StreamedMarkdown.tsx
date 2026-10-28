// A reply's text revealed a few characters per frame while it streams (user, 2026-10-28: "các text gen ra trả lời
// từ agent đang show 1 loạt làm animation ko mượt ... chỉ cho các đoạn text show từng chữ mượt mà hơn"). The model
// and the network deliver text in bursts; showing each burst as it lands made the reply jump a chunk at a time and
// then stall. Here what has arrived is a backlog the view catches up on at a pace set by how much is waiting, so
// the text flows evenly and never trails far behind.
//
// The live bubble and the finished message that replaces it share an id (Conversation's stepKey), so how far the
// reveal got is kept per id: the finished message carries on from there instead of jumping to the full text. A
// message that never streamed in this view (history, a reopened chat) shows in full at once.

import { useEffect, useRef, useState } from 'react'

import { Markdown } from './Markdown.tsx'

/** Characters shown so far, by message id, for replies streamed in this page view. */
const revealed = new Map<string, number>()

/** The backlog is caught up within about this long while text is still arriving… */
const DRAIN_MS = 450
/** …and faster once the reply is complete (nothing more to wait for). */
const FINISH_MS = 250
/** Never slower than this (characters per second), so a short tail doesn't crawl. */
const MIN_CPS = 45

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// Don't cut between the two halves of an emoji or other astral character.
function cut(text: string, length: number): string {
  const code = text.charCodeAt(length - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length + 1 : length)
}

/**
 * Closes the inline marks a partial reply leaves open (`**bold`, `` `code ``, `_x`…), so the text being revealed
 * shows formatted as it appears instead of with raw `**` that vanish a moment later when the closing pair lands.
 * Only the last paragraph is looked at, and nothing inside a code fence still open.
 */
function closeOpenMarks(partial: string): string {
  if ((partial.match(/^```/gm)?.length ?? 0) % 2 === 1) return partial
  // a mark cut in half at the very end (a lone `*` of a coming `**`) shows nothing yet
  let text = partial.replace(/(\*{1,2}|_{1,2}|`|~~?)$/, '')
  const paragraph = text.slice(text.lastIndexOf('\n\n') + 1)
  // inline code first: marks inside it are literal
  const ticks = paragraph.match(/`/g)?.length ?? 0
  if (ticks % 2 === 1) return `${text}\``
  const plain = paragraph.replace(/`[^`]*`/g, '')
  let closers = ''
  if ((plain.match(/\*\*/g)?.length ?? 0) % 2 === 1) closers += '**'
  // single `*` left once the `**` pairs and list bullets (`* item`) are out of the way
  if ((plain.replace(/\*\*/g, '').replace(/^\s*\* /gm, '').match(/\*/g)?.length ?? 0) % 2 === 1) closers = `*${closers}`
  if ((plain.match(/~~/g)?.length ?? 0) % 2 === 1) closers += '~~'
  // a closing mark right after a space doesn't close anything in Markdown: the space waits for the next word
  if (closers) text = text.trimEnd() + closers
  return text
}

export function StreamedMarkdown({ id, text, live = false }: { id: string; text: string; live?: boolean }) {
  const [shown, setShown] = useState(() => {
    if (reducedMotion()) return text.length
    const so = revealed.get(id)
    if (so !== undefined) return Math.min(so, text.length)
    return live ? 0 : text.length
  })
  const position = useRef(shown)
  const target = useRef(text.length)
  target.current = text.length
  const finishing = useRef(!live)
  finishing.current = !live

  useEffect(() => {
    if (position.current >= text.length) {
      if (!live) revealed.delete(id)
      return
    }
    let frame = 0
    let last = performance.now()
    const step = (now: number) => {
      const elapsed = Math.min(64, now - last)
      last = now
      const backlog = target.current - position.current
      const perMs = Math.max(MIN_CPS / 1000, backlog / (finishing.current ? FINISH_MS : DRAIN_MS))
      position.current = Math.min(target.current, position.current + Math.max(1, perMs * elapsed))
      const whole = Math.floor(position.current)
      revealed.set(id, whole)
      setShown(whole)
      if (position.current < target.current) frame = requestAnimationFrame(step)
      else if (finishing.current) revealed.delete(id)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
    // re-run when more text arrives or the reply completes; the loop reads the latest target from refs
  }, [id, text.length, live])

  // still arriving or still being revealed: a partial text, its open marks closed for now
  const partial = live || shown < text.length
  return <Markdown text={partial ? closeOpenMarks(shown >= text.length ? text : cut(text, shown)) : text} />
}
