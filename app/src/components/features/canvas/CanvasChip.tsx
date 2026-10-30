// How a canvas_write result shows in the chat log (ported from local-fox-harness-core's conversation.tsx): a compact
// chip instead of a tool pill, since the content lives in the side panel. A click opens that canvas on the version
// this chip stands for — or rebuilds it when it was closed from the panel's switcher.

import { Code2, FileSpreadsheet, FileText, FileType2 } from 'lucide-react'

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
    <div className="fh-tw fh-canvas-chip-row flex [margin:4px_0]">
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
