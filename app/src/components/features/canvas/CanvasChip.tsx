// How a canvas_write result shows in the chat log (ported from local-fox-harness-core's conversation.tsx): a compact
// chip instead of a tool pill, since the content lives in the side panel. A click opens that canvas on the version
// this chip stands for — or rebuilds it when it was closed from the panel's switcher.

import { Code2, FileSpreadsheet, FileText, FileType2, PanelRightOpen } from 'lucide-react'

import { useLocale } from '../../../i18n/locale.tsx'
import { canvasFileFormat, reopenCanvas, type CanvasKind } from './canvas.ts'
import { useCanvasStore } from './store.ts'

export interface CanvasChipEntry {
  canvasId: string
  canvasKind: CanvasKind
  path: string
  title: string
  version: number
}

export function CanvasChip({ entry }: { entry: CanvasChipEntry }) {
  const { t } = useLocale()
  const format = entry.canvasKind === 'file' ? canvasFileFormat(entry.path) : undefined
  const Icon = entry.canvasKind === 'code'
    ? Code2
    : format === 'xlsx' || format === 'csv' ? FileSpreadsheet : format === 'pdf' ? FileType2 : FileText
  return (
    <div className="fh-tw fh-canvas-chip-row">
      <button
        type="button"
        onClick={() => {
          const store = useCanvasStore.getState()
          const present = store.items[entry.canvasId] !== undefined
          if (!present && store.sessionId !== undefined) reopenCanvas(store.sessionId, entry.canvasId)
          store.setActiveId(entry.canvasId)
          if (present) store.setActiveVersion(entry.canvasId, entry.version)
          store.setOpen(true)
        }}
        className="flex max-w-[85%] items-center gap-2 overflow-hidden rounded-xl border border-border-subtle bg-bg-raised px-3 py-2 text-left text-[0.95em] text-fg transition-colors duration-100 ease-fh hover:bg-bg-hover"
      >
        <Icon size={17} className="flex-none text-accent" />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium">{entry.title}</span>
        <span className="flex-none text-[0.85em] text-muted">{t('canvas.openChip')}</span>
      </button>
    </div>
  )
}

/** "Reopen canvas: <title>" above the chat while the panel is closed but still holds a canvas. */
export function CanvasReopenBar() {
  const { t } = useLocale()
  const open = useCanvasStore((state) => state.open)
  const title = useCanvasStore((state) => (state.activeId === undefined ? undefined : state.items[state.activeId]?.title))
  const setOpen = useCanvasStore((state) => state.setOpen)
  if (open || title === undefined) return null
  return (
    <div className="fh-tw fh-canvas-reopen-row">
      <button
        type="button"
        onClick={() => { setOpen(true) }}
        className="mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-1.5 rounded-full border border-border-subtle bg-bg-raised px-3 py-1 text-[0.8em] text-muted hover:bg-bg-hover hover:text-fg"
      >
        <PanelRightOpen size={13} className="flex-none" />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{t('canvas.reopen', { title })}</span>
      </button>
    </div>
  )
}
