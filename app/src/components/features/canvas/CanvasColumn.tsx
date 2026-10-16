// The canvas as the frame's third column (ported from local-fox-harness-core's apps/web lib/use-layout-columns.ts,
// canvas part): drag the handle between chat and canvas to resize (the width persists per browser), double-click
// to go back to the automatic width. Below the sidebar's own auto-collapse breakpoint a third column would squeeze
// the chat to nothing, so the canvas overlays the chat instead and takes no grid width.

import { lazy, Suspense, useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'

import { useLocale } from '../../../i18n/locale.tsx'
// Loaded on first use: the panel brings CodeMirror and the file renderers (scripts/build.mjs splits them out).
const CanvasPanel = lazy(() => import('./CanvasPanel.tsx').then((module) => ({ default: module.CanvasPanel })))
import { useCanvasStore } from './store.ts'

const CANVAS_MIN_WIDTH = 320
const CANVAS_MAX_WIDTH = 900
// The chat keeps at least this much room however wide the canvas is dragged (the composer's controls need it).
const CENTER_MIN_WIDTH = 420
const HANDLE_WIDTH = 6
const STORAGE_CANVAS_WIDTH = 'fox-harness/canvasWidth'

function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

function storedWidth(): number | null {
  try {
    const stored = Number(localStorage.getItem(STORAGE_CANVAS_WIDTH))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  } catch {
    return null
  }
}

export interface CanvasLayout {
  // The canvas takes grid columns (handle + panel) after the chat.
  inGrid: boolean
  // The canvas overlays the chat (narrow viewport).
  overlay: boolean
  handleWidth: number
  width: number
  onResizeStart: (event: ReactMouseEvent) => void
  onResizeReset: () => void
}

/**
 * `available`: the canvas may show at all (a chat with a session is on screen). `frameWidth` and `sidebarWidth`
 * are the frame's and the sidebar column's current widths; `narrow` is the app's own auto-collapse breakpoint.
 */
export function useCanvasLayout(frameWidth: number, sidebarWidth: number, narrow: boolean, available: boolean): CanvasLayout {
  const open = useCanvasStore((state) => state.open && state.activeId !== undefined)
  const [override, setOverride] = useState<number | null>(storedWidth)
  // The width actually on screen, read at drag start so a drag starts from the true width, not a stale closure.
  const widthRef = useRef(0)

  const visible = open && available
  const overlay = visible && narrow
  const inGrid = visible && !narrow
  const wanted = override ?? clampWidth(frameWidth * 0.38, CANVAS_MIN_WIDTH, CANVAS_MAX_WIDTH)
  const width = inGrid ? Math.min(wanted, Math.max(CANVAS_MIN_WIDTH, frameWidth - sidebarWidth - HANDLE_WIDTH - CENTER_MIN_WIDTH)) : 0
  widthRef.current = width

  const onResizeStart = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    function onMove(move: MouseEvent): void {
      // The handle is the canvas's LEFT edge: dragging left widens it.
      setOverride(clampWidth(startWidth + (startX - move.clientX), CANVAS_MIN_WIDTH, CANVAS_MAX_WIDTH))
    }
    function onUp(): void {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setOverride((current) => {
        try {
          if (current !== null) localStorage.setItem(STORAGE_CANVAS_WIDTH, String(current))
        } catch {
          // storage unavailable: the width holds for this page view
        }
        return current
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const onResizeReset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_CANVAS_WIDTH)
    } catch {
      // nothing stored to clear
    }
    setOverride(null)
  }, [])

  return { inGrid, overlay, handleWidth: HANDLE_WIDTH, width, onResizeStart, onResizeReset }
}

/** The handle and the panel: two grid children after the chat column, or one fixed overlay. */
export function CanvasColumn({ layout, sessionId }: { layout: CanvasLayout; sessionId: string }) {
  const { t } = useLocale()
  if (layout.overlay) {
    return (
      <div className="fh-tw fh-canvas-overlay">
        <Suspense fallback={null}>
          <CanvasPanel sessionId={sessionId} overlay />
        </Suspense>
      </div>
    )
  }
  if (!layout.inGrid) return null
  return (
    <>
      <div
        className="fh-canvas-handle"
        role="separator"
        aria-orientation="vertical"
        title={t('canvas.resizeHandle')}
        onMouseDown={layout.onResizeStart}
        onDoubleClick={layout.onResizeReset}
      />
      <div className="fh-tw fh-canvas-col">
        <Suspense fallback={null}>
          <CanvasPanel sessionId={sessionId} />
        </Suspense>
      </div>
    </>
  )
}
