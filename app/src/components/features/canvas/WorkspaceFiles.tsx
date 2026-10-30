// The chat's files as folders by origin (source / shared / this chat / other chats), each opening onto its files
// (replaces the old one-line "Files (n)" toggle, conversation/WorkspacePanel.tsx). Ported in part from local-fox-harness-core's workspace-files.tsx: every file opens in the canvas panel (which has its own
// Download), "Download all" zips them in the browser, and a turn that wrote an Excel/Word/PDF file without putting
// it on the canvas gets it opened anyway.
//
// A project chat sees the project's uploads and shared outputs plus only its OWN generated/ files; a canvas's
// versions (canvas-<id>-vN.ext) show as one card, the latest; Office/PDF snapshots show none (the original has one).

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderDown, FolderOpen, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { useLocale } from '../../../i18n/locale.tsx'
import type { TranslationKey } from '../../../i18n/translations.ts'
import { useRuntime } from '../../../runtime.ts'
import { formatSize, listWorkspaceFiles, type WorkspaceFile } from '../conversation/workspaceApi.ts'
import { StorageFullError, showNoSpace } from '../settings/storageApi.ts'
import { fetchCanvasFile, fileCanvasVersionCount, isOfficeDeliverable, openWorkspaceFileInCanvas } from './canvas.ts'
import { CANVAS_VERSION_RE, fileKind, isChatResult, useSessionFiles } from './sessionFiles.ts'

// Container and browser clocks may disagree a little.
const TURN_CLOCK_SLACK_MS = 10_000
// A turn that wrote many files (a batch of charts) opens only its newest few; the turn's file box lists them all.
const AUTO_OPEN_MAX = 3

interface Card {
  file: WorkspaceFile
  name: string
  modified: number
}

type Group = { key: 'source' | 'shared' | 'own' | 'other'; label: TranslationKey; cards: Card[] }

function relativeTime(ms: number, locale: string): string {
  const seconds = Math.round((ms - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(seconds, 'second')
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour')
  return format.format(Math.round(seconds / 86_400), 'day')
}

/** One card per file, and one per canvas (its latest version), newest first. */
function toCards(files: WorkspaceFile[]): Card[] {
  const latestCanvas = new Map<string, { version: number; card: Card }>()
  const cards: Card[] = []
  for (const file of files) {
    const card = { file, name: file.path.split('/').pop() ?? file.path, modified: Date.parse(file.modified) }
    const match = CANVAS_VERSION_RE.exec(file.path)
    if (match === null) {
      cards.push(card)
      continue
    }
    // A kind:"file" snapshot is a byte copy of a file the model wrote: that original already has its card.
    if (isOfficeDeliverable(file.path)) continue
    const key = `${file.path.slice(0, match.index)}${match[2]}${match[4]}`
    const version = Number(match[3])
    const seen = latestCanvas.get(key)
    if (seen === undefined || version > seen.version) latestCanvas.set(key, { version, card })
  }
  return [...cards, ...[...latestCanvas.values()].map((entry) => entry.card)].sort((a, b) => b.modified - a.modified)
}

export function WorkspaceFiles({ version = 0, running }: { version?: number; running: boolean }) {
  const runtime = useRuntime()
  const { t, locale } = useLocale()
  const sessionId = runtime.sessionId
  const [files, setFiles] = useState<WorkspaceFile[] | undefined>()
  const [open, setOpen] = useState(false)
  const [zipping, setZipping] = useState(false)
  const [opening, setOpening] = useState<string | undefined>()
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ own: true })

  async function refresh(): Promise<WorkspaceFile[] | undefined> {
    if (!sessionId) return undefined
    try {
      const listed = (await listWorkspaceFiles(runtime, `/sessions/${sessionId}`))?.filter(
        (file) => !file.sessionId || file.sessionId === sessionId,
      )
      setFiles(listed)
      return listed
    } catch {
      return undefined // keep the last list; the next turn end refreshes again
    }
  }

  useEffect(() => {
    setFiles(undefined)
    setOpen(false)
    void refresh()
    // The model writes files during a turn: refresh when one ends. onFrame replays past frames on subscribe — skip.
    let live = false
    const unsubscribe = runtime.onFrame((frame) => {
      if (live && frame.type === 'event' && frame.event.type === 'turn/end') void refresh()
    })
    live = true
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (version > 0) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // the chat log's per-turn file boxes (TurnFiles.tsx) read this same list
  useEffect(() => {
    useSessionFiles.getState().publish(sessionId, files)
  }, [sessionId, files])

  // Auto-open: a turn that wrote or rewrote files of its own (by mtime, against a baseline taken when the turn
  // started) without attaching any file canvas itself gets them opened in the panel, newest last so it ends up on
  // screen. Only files modified after the turn started count, so replaying an old session's history opens nothing.
  // User (2026-10-28): "khi Agent gen ra 1 file trong 1 đoạn chat xong nên có auto open luôn" — every file the
  // chat wrote (HTML, Markdown, images, ...), no longer only Excel/Word/PDF.
  const baseline = useRef<{ modified: Map<string, string>; fileCanvases: number; startedAt: number } | undefined>(undefined)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (running && !wasRunning.current && files !== undefined) {
      baseline.current = { modified: new Map(files.map((f) => [f.path, f.modified])), fileCanvases: fileCanvasVersionCount(), startedAt: Date.now() }
    }
    if (!running && wasRunning.current && baseline.current !== undefined && sessionId) {
      const before = baseline.current
      baseline.current = undefined
      void refresh().then((listed) => {
        if (listed === undefined || fileCanvasVersionCount() > before.fileCanvases) return
        const changed = listed
          .filter((f) => before.modified.get(f.path) !== f.modified && Date.parse(f.modified) >= before.startedAt - TURN_CLOCK_SLACK_MS)
          .filter((f) => isChatResult(f, sessionId))
          .sort((a, b) => Date.parse(a.modified) - Date.parse(b.modified))
          .slice(-AUTO_OPEN_MAX)
        // Sequential, oldest first, so the newest ends up the canvas on screen.
        void changed.reduce<Promise<void>>(
          (previous, f) => previous.then(() => openWorkspaceFileInCanvas(sessionId, { path: f.path, modified: Date.parse(f.modified), size: f.sizeBytes })).catch((error: unknown) => { if (error instanceof StorageFullError) showNoSpace(error, t) }),
          Promise.resolve(),
        )
      })
    }
    wasRunning.current = running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  const groups = useMemo<Group[]>(() => {
    const cards = toCards(files ?? [])
    return ([
      { key: 'source', label: 'workspace.originSource', cards: cards.filter((c) => c.file.origin === 'source') },
      { key: 'shared', label: 'workspace.originShared', cards: cards.filter((c) => c.file.origin === 'shared') },
      { key: 'own', label: 'workspace.originChat', cards: cards.filter((c) => c.file.origin === 'chat' && c.file.sessionId === sessionId) },
      { key: 'other', label: 'workspace.originOther', cards: cards.filter((c) => c.file.origin === 'chat' && c.file.sessionId !== sessionId) },
    ] satisfies Group[]).filter((group) => group.cards.length > 0)
  }, [files, sessionId])

  const total = groups.reduce((sum, group) => sum + group.cards.length, 0)
  if (!sessionId || total === 0) return null

  async function openCard(card: Card): Promise<void> {
    if (!sessionId) return
    setOpening(card.file.path)
    try {
      await openWorkspaceFileInCanvas(sessionId, { path: card.file.path, modified: card.modified, size: card.file.sizeBytes })
    } catch (error) {
      if (error instanceof StorageFullError) showNoSpace(error, t)
      else toast.error(t('workspace.openFailed', { name: card.name }))
    } finally {
      setOpening(undefined)
    }
  }

  async function downloadAll(): Promise<void> {
    if (zipping || !sessionId) return
    setZipping(true)
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      for (const group of groups) {
        for (const card of group.cards) {
          const bytes = await (await fetchCanvasFile(sessionId, card.file.path)).arrayBuffer()
          zip.file(card.file.path, bytes, { date: new Date(card.modified) })
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `files-${sessionId.slice(0, 8)}.zip`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
    } catch (error) {
      toast.error(t('workspace.zipFailed', { reason: error instanceof Error ? error.message : String(error) }))
    } finally {
      setZipping(false)
    }
  }

  return (
    <div className="fh-tw fh-workspace-files [margin:0_1em_0.5em] flex-none">
      <div className="rounded-xl border border-border bg-surface">
        <div className="flex items-center gap-1 pr-1.5">
          <button
            type="button"
            onClick={() => { setOpen(!open) }}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:text-fg"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="truncate font-medium">{t('workspace.title')}</span>
            <span className="rounded-full bg-bg-hover px-1.5 tabular-nums">{total}</span>
          </button>
          <button
            type="button"
            onClick={() => { void downloadAll() }}
            disabled={zipping}
            title={t('workspace.downloadAll')}
            className="flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-bg-hover hover:text-fg disabled:opacity-60"
          >
            {zipping ? <Loader2 size={13} className="animate-spin" /> : <FolderDown size={13} />}
            <span>{zipping ? t('workspace.zipping') : t('workspace.downloadAllShort')}</span>
          </button>
        </div>
        {open ? (
          <div className="max-h-64 overflow-y-auto border-t border-border p-2">
            {groups.map((group) => {
              const expanded = openGroups[group.key] === true
              return (
                <section key={group.key}>
                  <button
                    type="button"
                    onClick={() => { setOpenGroups((previous) => ({ ...previous, [group.key]: !expanded })) }}
                    className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs hover:bg-bg-hover"
                  >
                    {expanded ? <ChevronDown size={13} className="flex-none text-muted" /> : <ChevronRight size={13} className="flex-none text-muted" />}
                    {expanded ? <FolderOpen size={14} className="flex-none text-accent" /> : <Folder size={14} className="flex-none text-accent" />}
                    <span className="min-w-0 flex-1 truncate text-fg">{t(group.label)}</span>
                    <span className="flex-none tabular-nums text-muted">{group.cards.length}</span>
                  </button>
                  {expanded ? (
                    <ul className="m-0 ml-3 list-none border-l border-border py-0.5 pl-1.5">
                      {group.cards.map((card) => {
                        const { Icon, tone } = fileKind(card.file.path)
                        return (
                          <li key={card.file.path}>
                            <button
                              type="button"
                              title={`${card.file.path} · ${relativeTime(card.modified, locale)} — ${t('workspace.openInCanvas')}`}
                              onClick={() => { void openCard(card) }}
                              className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-bg-hover"
                            >
                              {opening === card.file.path ? <Loader2 size={13} className="flex-none animate-spin text-muted" /> : <Icon size={13} className={`flex-none ${tone}`} />}
                              <span className="min-w-0 flex-1 truncate text-accent-text">{card.name}</span>
                              <span className="flex-none tabular-nums text-muted">{formatSize(card.file.sizeBytes)}</span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                </section>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
