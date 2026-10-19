// The chat log's scrolling, the way claude.ai does it (2026-10-19). It replaces a plain "scrollTop = scrollHeight on
// every change", which dragged the reader back down on every streamed token.
//
// - Pinned to the bottom (the default, and after a send): new content comes into view. A small gap (the next line
//   of a streamed reply) is closed at once, so the newest text never trails behind the bottom edge; a big one (a
//   chart, a table, the jump back down) eases in, each frame closing a share of what is left.
// - The reader scrolls up, by any means (wheel, touch, keys, the scrollbar): the pin is released at once, and the
//   view stays where they put it while the reply keeps streaming below.
// - Back within a few pixels of the bottom: pinned again.
// - Opening a chat: jumpToBottom() lands at the end with no animation.
// Content changes are watched in the DOM itself (mutations, resizes, images loading), so a chart that renders a
// moment after its message still keeps a pinned view at the bottom. prefers-reduced-motion jumps instead of gliding.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** Within this of the bottom counts as "at the bottom": scrolling back here pins again. */
const REATTACH_PX = 24
/** Share of a big gap closed per frame while following (about 200 ms to settle on a 60 Hz screen). */
const FOLLOW_SHARE = 0.25
/** A gap up to this (about two lines) is closed at once: easing it would only make streamed text lag. */
const SNAP_PX = 80

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
const gapOf = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

export function useStickToBottom(ref: RefObject<HTMLElement | null>): {
  /** false while the reader is somewhere above the end (show a "jump to latest" button then) */
  atBottom: boolean
  /** pin and glide to the end (a send, the button) */
  scrollToBottom: () => void
  /** pin and land at the end at once (a chat just opened) */
  jumpToBottom: () => void
} {
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const frame = useRef<number | undefined>(undefined)
  const lastTop = useRef(0)

  const setPinned = useCallback((value: boolean) => {
    pinned.current = value
    setAtBottom(value)
  }, [])

  const follow = useCallback(() => {
    if (frame.current !== undefined) return
    const step = () => {
      frame.current = undefined
      const el = ref.current
      if (!el || !pinned.current) return
      const gap = gapOf(el)
      if (gap <= 1) return
      if (gap <= SNAP_PX || reducedMotion()) {
        el.scrollTop = el.scrollHeight
        lastTop.current = el.scrollTop
        return
      }
      el.scrollTop += Math.max(1, Math.ceil(gap * FOLLOW_SHARE))
      lastTop.current = el.scrollTop
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
  }, [ref])

  const scrollToBottom = useCallback(() => {
    setPinned(true)
    follow()
  }, [follow, setPinned])

  const jumpToBottom = useCallback(() => {
    const el = ref.current
    setPinned(true)
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }, [ref, setPinned])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    lastTop.current = el.scrollTop

    // Only the reader moves the view up (this hook only ever scrolls down), so an upward move releases the pin;
    // reaching the bottom again, by whatever means, re-pins.
    const onScroll = () => {
      const top = el.scrollTop
      const movedUp = top < lastTop.current - 1
      lastTop.current = top
      if (gapOf(el) <= REATTACH_PX) {
        if (!pinned.current) setPinned(true)
      } else if (movedUp && pinned.current) {
        setPinned(false)
      }
    }
    // A wheel or swipe upward releases before the first scroll event lands, so a streaming reply cannot pull
    // the view back down in between.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && pinned.current && el.scrollHeight > el.clientHeight) setPinned(false)
    }
    let touchY: number | undefined
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      if (touchY !== undefined && y !== undefined && y > touchY + 4 && pinned.current) setPinned(false)
    }
    const onChange = () => {
      if (pinned.current) follow()
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    // an image or chart that finishes loading grows the log after its message rendered
    el.addEventListener('load', onChange, true)
    const mutations = new MutationObserver(onChange)
    mutations.observe(el, { childList: true, subtree: true, characterData: true })
    const resizes = new ResizeObserver(onChange)
    resizes.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('load', onChange, true)
      mutations.disconnect()
      resizes.disconnect()
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
      frame.current = undefined
    }
    // the log element mounts once the chat has content (`!isEmpty`): re-attach when it appears
  }, [ref, ref.current, follow, setPinned])

  return { atBottom, scrollToBottom, jumpToBottom }
}
