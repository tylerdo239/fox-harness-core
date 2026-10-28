// User (2026-10-28): "cuối đoạn chat tạo file đó phải show 1 box thông tin file đó và có nút download ở cuối cũng
// như nếu ấn vào thì mở nếu chưa mở". At the end of a turn, the files that turn wrote: a click opens the file in the
// canvas panel (or brings it forward), the button at the row's end downloads it. A file belongs to the turn whose
// time span holds its mtime (both are the backend's clock), so a reopened chat shows the same boxes; a file
// rewritten by a later turn moves to that turn's box.

import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { useLocale } from '../../../i18n/locale.tsx'
import { formatSize } from '../conversation/workspaceApi.ts'
import { StorageFullError, showNoSpace } from '../settings/storageApi.ts'
import { fetchCanvasFile, openWorkspaceFileInCanvas, workspaceCanvasId } from './canvas.ts'
import { fileType, isChatResult, useSessionFiles } from './sessionFiles.ts'
import { useCanvasStore } from './store.ts'

// mtimes are whole seconds on some filesystems, and the turn's events are stamped a moment around the tool's write
const SPAN_SLACK_MS = 2_000

export interface TurnFilesEntry {
  startedAt: number
  endedAt: number
}

export function TurnFiles({ entry }: { entry: TurnFilesEntry }) {
  const { t } = useLocale()
  const sessionId = useSessionFiles((state) => state.sessionId)
  const files = useSessionFiles((state) => state.files)
  const activeId = useCanvasStore((state) => (state.open ? state.activeId : undefined))
  const [busy, setBusy] = useState<string | undefined>()

  if (!sessionId || !files) return null
  const own = files
    .filter((file) => isChatResult(file, sessionId))
    .map((file) => ({ file, name: file.path.split('/').pop() ?? file.path, modified: Date.parse(file.modified) }))
    .filter((card) => card.modified >= entry.startedAt - SPAN_SLACK_MS && card.modified <= entry.endedAt + SPAN_SLACK_MS)
    .sort((a, b) => a.modified - b.modified)
  if (own.length === 0) return null

  async function open(card: (typeof own)[number]): Promise<void> {
    if (!sessionId) return
    setBusy(card.file.path)
    try {
      await openWorkspaceFileInCanvas(sessionId, { path: card.file.path, modified: card.modified, size: card.file.sizeBytes })
    } catch (error) {
      if (error instanceof StorageFullError) showNoSpace(error, t)
      else toast.error(t('workspace.openFailed', { name: card.name }))
    } finally {
      setBusy(undefined)
    }
  }

  async function download(card: (typeof own)[number]): Promise<void> {
    if (!sessionId) return
    try {
      const blob = await (await fetchCanvasFile(sessionId, card.file.path)).blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = card.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
    } catch {
      toast.error(t('turnFiles.downloadFailed', { name: card.name }))
    }
  }

  return (
    <div className="fh-tw fh-turn-files">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {own.map((card) => {
          const { Icon, color, label } = fileType(card.file.path)
          const shown = activeId === workspaceCanvasId(card.file.path)
          const folder = card.file.path.includes('/') ? card.file.path.slice(0, card.file.path.lastIndexOf('/')) : ''
          return (
            <li
              key={card.file.path}
              className={`flex items-center gap-2 rounded-2xl border bg-surface pr-3 transition-colors duration-100 ease-fh hover:bg-bg-hover ${shown ? 'border-accent' : 'border-border'}`}
            >
              <button
                type="button"
                onClick={() => { void open(card) }}
                title={`${card.file.path} — ${t('workspace.openInCanvas')}`}
                className="flex h-auto min-w-0 flex-1 items-center gap-3.5 py-3 pl-3.5 text-left"
              >
                <span
                  className="flex h-12 w-12 flex-none items-center justify-center rounded-xl"
                  style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
                >
                  {busy === card.file.path ? <Loader2 size={22} className="animate-spin" /> : <Icon size={22} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[1.05em] font-medium text-fg">{card.name}</span>
                  <span className="truncate text-[0.85em] text-muted">
                    <span className="font-semibold" style={{ color }}>{label}</span>
                    {` · ${formatSize(card.file.sizeBytes)}`}
                    {folder ? ` · ${folder}` : ''}
                    {shown ? ` · ${t('turnFiles.shown')}` : ''}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => { void download(card) }}
                title={t('canvas.download')}
                aria-label={`${t('canvas.download')} ${card.name}`}
                className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-border bg-bg text-muted hover:text-fg"
              >
                <Download size={18} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
