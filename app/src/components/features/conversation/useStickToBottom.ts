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
// - Sending (anchorToLatest, user 2026-10-28: "khi chat đoạn mới box chat user kéo lên đầu view và show chat từ đó
//   như các agent web khác"): once the new message is in the log it glides to the top of the view and the reply
//   fills in below it. A spacer at the log's end (`spacerRef`) holds the room below a short reply so the message
//   can sit at the top; it shrinks as the reply grows. Once the reply fills the view the spacer is gone and the
//   view follows the reply down like any pinned view (user: "phải có tự scroll nữa chớ"); the reader scrolling at
//   any point hands the view back to them.
// Content changes are watched in the DOM itself (mutations, resizes, images loading), so a chart that renders a
// moment after its message still keeps a pinned view at the bottom. prefers-reduced-motion jumps instead of gliding.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** Within this of the bottom counts as "at the bottom": scrolling back here pins again. */
const REATTACH_PX = 24
/** Share of a big gap closed per frame while following (about 200 ms to settle on a 60 Hz screen). */
const FOLLOW_SHARE = 0.25
/** A gap up to this (about two lines) is closed at once: easing it would only make streamed text lag. */
const SNAP_PX = 80
/** A scroll this soon after the reader's own input (wheel, touch, key) is theirs; kinetic trackpad scrolling keeps
 * sending wheel events, so this only has to bridge the gap between an input and its scroll event. */
const INPUT_WINDOW_MS = 400

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
const gapOf = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

export function useStickToBottom(ref: RefObject<HTMLElement | null>, spacerRef: RefObject<HTMLElement | null>): {
  /** false while the reader is somewhere above the end (show a "jump to latest" button then) */
  atBottom: boolean
  /** pin and glide to the end (a send, the button) */
  scrollToBottom: () => void
  /** pin and land at the end at once (a chat just opened) */
  jumpToBottom: () => void
  /** the next element matching `selector` to appear (the message just sent) glides to the top of the view */
  anchorToLatest: (selector: string) => void
} {
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const frame = useRef<number | undefined>(undefined)
  const lastTop = useRef(0)
  // waiting for the sent message to render: how many matched before it
  const pendingAnchor = useRef<{ selector: string; count: number } | undefined>(undefined)
  // the message at the top of the view; `holding` while the reader hasn't scrolled since
  const anchor = useRef<HTMLElement | undefined>(undefined)
  const holding = useRef(false)

  const syncAtBottom = useCallback(() => {
    const el = ref.current
    setAtBottom(pinned.current || (el !== null && gapOf(el) <= REATTACH_PX))
  }, [ref])

  // The room the anchored message needs below it to reach the top of the view.
  const fitSpacer = useCallback(() => {
    const el = ref.current
    const spacer = spacerRef.current
    if (!el || !spacer) return
    const target = anchor.current
    if (!target || !target.isConnected) {
      anchor.current = undefined
      spacer.style.height = '0px'
      return
    }
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const top = target.getBoundingClientRect().top - box.top + el.scrollTop - parseFloat(style.paddingTop)
    const end = spacer.getBoundingClientRect().top - box.top + el.scrollTop
    const needed = top + el.clientHeight - end - parseFloat(style.paddingBottom)
    spacer.style.height = `${Math.max(0, Math.floor(needed))}px`
  }, [ref, spacerRef])

  // Glide the anchored message to the top of the view: time-based, easing out, so it moves evenly whatever the
  // distance (no `smooth` scrolling: its scroll events would read as the reader scrolling). The goal is re-read every
  // frame, so the reply starting to render below it changes nothing.
  const glideToAnchor = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    const el = ref.current
    if (!el) return
    const goalOf = (target: HTMLElement) => Math.min(
      el.scrollHeight - el.clientHeight,
      target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - parseFloat(getComputedStyle(el).paddingTop),
    )
    const from = el.scrollTop
    const started = performance.now()
    let duration: number | undefined
    const step = (now: number) => {
      frame.current = undefined
      const target = anchor.current
      if (!target || !holding.current) return
      const goal = goalOf(target)
      // 300 ms for a short hop, up to 500 ms for a long one
      duration ??= reducedMotion() ? 0 : Math.min(500, 300 + Math.abs(goal - from) / 10)
      const progress = duration === 0 ? 1 : Math.min(1, (now - started) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      el.scrollTop = from + (goal - from) * eased
      lastTop.current = el.scrollTop
      if (progress < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
  }, [ref])

  const placeAnchor = useCallback(() => {
    const el = ref.current
    const pending = pendingAnchor.current
    if (!el || !pending) return
    const matches = el.querySelectorAll<HTMLElement>(pending.selector)
    if (matches.length <= pending.count) return
    pendingAnchor.current = undefined
    anchor.current = matches[matches.length - 1]
    holding.current = true
    pinned.current = false
    fitSpacer()
    glideToAnchor()
  }, [ref, fitSpacer, glideToAnchor])

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
    holding.current = false
    pendingAnchor.current = undefined
    setPinned(true)
    follow()
  }, [follow, setPinned])

  const jumpToBottom = useCallback(() => {
    const el = ref.current
    holding.current = false
    pendingAnchor.current = undefined
    anchor.current = undefined
    fitSpacer()
    setPinned(true)
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }, [ref, setPinned, fitSpacer])

  const anchorToLatest = useCallback((selector: string) => {
    const el = ref.current
    pendingAnchor.current = { selector, count: el ? el.querySelectorAll(selector).length : 0 }
    holding.current = false
    pinned.current = false
    // already rendered (or the log mounts with it): place it now
    requestAnimationFrame(placeAnchor)
  }, [ref, placeAnchor])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    lastTop.current = el.scrollTop

    // The reader's own input (wheel, touch, keys, a press on the scrollbar). A scroll counts as theirs only right
    // after it: content that shrinks (a pill collapsing, the streamed text swapped for the final message) also moves
    // the view, clamped, and must not release the pin.
    let lastInput = -Infinity
    let pressing = false
    const input = () => { lastInput = performance.now() }
    const byReader = () => pressing || performance.now() - lastInput < INPUT_WINDOW_MS

    // Any move up by the reader releases the pin, however small (a trackpad scrolls a few pixels at a time, still
    // within REATTACH_PX of the bottom); only the reader coming back down to the bottom pins again (user,
    // 2026-10-28: "nếu tôi scroll lên 1 đoạn so với bottom thì autoscroll phải bị ngắt và nếu tôi lại scroll tới
    // bottom đang gen thì lại tiếp tục có autoscroll").
    const onScroll = () => {
      const top = el.scrollTop
      const delta = top - lastTop.current
      lastTop.current = top
      const reader = byReader()
      if (reader && Math.abs(delta) > 1) holding.current = false
      if (holding.current) {
        syncAtBottom()
        return
      }
      if (reader && delta < -1) {
        if (pinned.current) setPinned(false)
      } else if (!pinned.current && gapOf(el) <= REATTACH_PX && (delta > 1 || !reader)) {
        setPinned(true)
      }
      syncAtBottom()
    }
    // A wheel or swipe upward releases before the first scroll event lands, so a streaming reply cannot pull
    // the view back down in between. Down at the very bottom (no scroll event: nowhere to go) pins again.
    const onWheel = (event: WheelEvent) => {
      input()
      holding.current = false
      if (event.deltaY < 0 && el.scrollHeight > el.clientHeight) {
        if (pinned.current) setPinned(false)
      } else if (event.deltaY > 0 && !pinned.current && gapOf(el) <= REATTACH_PX) {
        setPinned(true)
      }
    }
    let touchY: number | undefined
    const onTouchStart = (event: TouchEvent) => {
      input()
      touchY = event.touches[0]?.clientY
    }
    const onTouchMove = (event: TouchEvent) => {
      input()
      const y = event.touches[0]?.clientY
      if (touchY !== undefined && y !== undefined && y > touchY + 4 && pinned.current) setPinned(false)
    }
    const onKeyDown = () => input()
    // a press on the scrollbar lands on the log itself; the drag lasts until the button comes up anywhere
    const onPointerDown = () => {
      input()
      pressing = true
    }
    const onPointerUp = () => {
      if (pressing) input()
      pressing = false
    }
    const onChange = () => {
      placeAnchor()
      if (anchor.current) fitSpacer()
      // the reply now fills the view below the sent message: from here on, follow it down
      if (holding.current && frame.current === undefined && spacerRef.current?.style.height === '0px' && gapOf(el) > 1) {
        holding.current = false
        setPinned(true)
      }
      if (pinned.current) follow()
      syncAtBottom()
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
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
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      el.removeEventListener('load', onChange, true)
      mutations.disconnect()
      resizes.disconnect()
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
      frame.current = undefined
    }
    // the log element mounts once the chat has content (`!isEmpty`): re-attach when it appears
  }, [ref, ref.current, spacerRef, follow, setPinned, placeAnchor, fitSpacer, syncAtBottom])

  return { atBottom, scrollToBottom, jumpToBottom, anchorToLatest }
}
