// The canvas side panel, ported from local-fox-harness-core (apps/web/components/features/canvas/canvas-panel.tsx).
// api/packages/tool/canvas and ./canvas.ts are the rest of the feature (marker protocol, versions as files).
// Differences: files come through the session's authenticated files route (Download fetches a blob), and an HTML
// preview's runtime errors are shown to the user only (the source app also sent them to the model as a note).
//
// One panel, one active canvas at a time (useCanvasStore's `activeId`)
// — multiple canvases can exist in a session (different `canvas_write` ids),
// but only the most recently touched one is on screen; switching between
// them is a future nicety, not something either priority (code, long
// markdown) asked for.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown as markdownLang } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import type { Extension } from '@codemirror/state'
import CodeMirror from '@uiw/react-codemirror'
import { diffLines } from 'diff'
import { AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, Code2, Copy, Download, File as FileIcon, FileSpreadsheet, FileText, FileType2, Image as ImageIcon, Loader2, X } from 'lucide-react'
import { useLocale } from '../../../i18n/locale.tsx'
import { useTheme } from '../../../useTheme.ts'
import { Markdown } from '../conversation/Markdown.tsx'
import { canvasFileFormat, closeCanvas, dismissPanel, fetchCanvasFile, saveCanvasEdit } from './canvas.ts'
import { FilePreview, SpreadsheetDiff } from './FilePreview.tsx'
import { useCanvasStore, type CanvasItem } from './store.ts'

// Best-effort language -> CodeMirror extension. An unrecognized language
// (or none — plain-text canvases are valid) simply gets no extension, which
// CodeMirror renders as unhighlighted plain text, never an error.
const LANGUAGE_EXTENSION: Record<string, () => Extension> = {
  typescript: () => javascript({ typescript: true, jsx: true }),
  ts: () => javascript({ typescript: true, jsx: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  javascript: () => javascript({ jsx: true }),
  js: () => javascript({ jsx: true }),
  jsx: () => javascript({ jsx: true }),
  python: () => python(),
  py: () => python(),
  json: () => json(),
  css: () => css(),
  scss: () => css(),
  html: () => html(),
  sql: () => sql(),
  yaml: () => yaml(),
  yml: () => yaml(),
  markdown: () => markdownLang(),
  md: () => markdownLang(),
}

function extensionsFor(path: string, language: string | undefined): Extension[] {
  const key = (language ?? path.slice(path.lastIndexOf('.') + 1)).toLowerCase()
  const factory = LANGUAGE_EXTENSION[key]
  return factory === undefined ? [] : [factory()]
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 font-medium transition-colors duration-100 ease-fh ${active ? 'bg-bg-raised text-fg' : 'text-muted hover:text-fg'}`}
    >
      {children}
    </button>
  )
}

/** Line-level diff against the previous version, `diff`'s own `diffLines` — no merge/inline-word diff, matching this app's other bespoke-but-plain rendering (ToolPill, AttachmentCard) rather than pulling in a heavier diff-view library. */
function DiffView({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffLines(before, after), [before, after])
  return (
    <div className="h-full overflow-y-auto overscroll-contain whitespace-pre-wrap break-words p-4 font-mono text-[0.85em] leading-relaxed">
      {parts.map((part, partIndex) => {
        const lines = part.value.split('\n')
        if (lines.at(-1) === '') lines.pop()
        const sign = part.added ? '+' : part.removed ? '-' : ' '
        const rowClass = part.added
          ? 'bg-status-success/15 text-fg'
          : part.removed
            ? 'bg-status-danger/15 text-muted line-through decoration-error/40'
            : 'text-muted'
        return lines.map((line, lineIndex) => (
          <div key={`${String(partIndex)}-${String(lineIndex)}`} className={rowClass}>
            <span className="mr-2 select-none opacity-60">{sign}</span>{line === '' ? ' ' : line}
          </div>
        ))
      })}
    </div>
  )
}

// Real failure this exists for: a model-written three.js page loaded
// `three@0.160.0/examples/js/controls/OrbitControls.js` — a path three.js
// removed in r148, so a 404 — then threw on `new THREE.OrbitControls(...)`
// before the scene was ever built. The preview showed the page's static HUD
// over an empty dark background and nothing else: no hint anywhere that the
// page had crashed, so it just looked like the canvas itself was broken.
// This probe is injected into the previewed document (never saved to the
// file) and reports uncaught errors, unhandled rejections and failed
// <script>/<link> loads to the panel via postMessage. The iframe has an
// opaque origin (no allow-same-origin), so postMessage is the only channel.
const PREVIEW_ERROR_TAG = 'fh-canvas-preview-error'
// Kept on ONE line: it's inserted mid-line, so any newline in it would shift
// every line number the page's own errors report.
const PREVIEW_ERROR_PROBE = `<script>(function(){function send(m){try{parent.postMessage({type:'${PREVIEW_ERROR_TAG}',message:String(m)},'*')}catch(e){}}addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){send('Failed to load '+(t.src||t.href));return}send((e.message||'Error')+(e.lineno?' (line '+e.lineno+')':''))},true);addEventListener('unhandledrejection',function(e){var r=e.reason;send(r&&r.message?r.message:r)});})()</script>`

/** Inserts the probe as early as possible (it must be registered before the page's own scripts run) without putting anything ahead of `<!DOCTYPE>`, which would drop the page into quirks mode. */
function withErrorProbe(source: string): string {
  const anchor = /<head[^>]*>/i.exec(source) ?? /<html[^>]*>/i.exec(source) ?? /<!doctype[^>]*>/i.exec(source)
  if (anchor === null) return PREVIEW_ERROR_PROBE + source
  const at = anchor.index + anchor[0].length
  return source.slice(0, at) + PREVIEW_ERROR_PROBE + source.slice(at)
}

function HtmlPreview({ source, title }: { source: string; title: string }) {
  const { t } = useLocale()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [errors, setErrors] = useState<string[]>([])
  const srcDoc = useMemo(() => withErrorProbe(source), [source])

  useEffect(() => {
    setErrors([])
    function onMessage(event: MessageEvent): void {
      if (event.source === null || event.source !== frameRef.current?.contentWindow) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== PREVIEW_ERROR_TAG) return
      const message = String((data as { message?: unknown }).message)
      setErrors(current => (current.includes(message) || current.length >= 20 ? current : [...current, message]))
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [srcDoc])


  return (
    <div className="flex h-full flex-col">
      {errors.length > 0 ? (
        <div className="flex max-h-32 flex-none gap-2 overflow-y-auto border-b border-border-subtle bg-bubble-live px-3 py-2 text-[0.8em] text-error">
          <AlertTriangle size={14} className="mt-0.5 flex-none" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t('canvas.previewErrors')}</div>
            {errors.map(message => <div key={message} className="break-words font-mono">{message}</div>)}
          </div>
        </div>
      ) : null}
      {/* No `allow-same-origin` on purpose: the generated page runs at an
          opaque origin with no access to this app's cookies, storage, or
          DOM — the same sandboxing an artifact/canvas preview needs for
          arbitrary model-written HTML, regardless of how trusted this
          deployment's one admin user is. */}
      <iframe
        ref={frameRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        title={title}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  )
}

type Tab = 'preview' | 'edit' | 'diff'

/**
 * Name the Download button saves under. A canvas opened from the workspace
 * list is titled by its own filename — use it, not the snapshot's
 * `canvas-ws-…-v2.xlsx`. A model file canvas gets its title plus the real
 * extension ("Báo giá chatbot CSKH.xlsx"). Text canvases keep the default.
 */
function downloadName(item: CanvasItem, path: string): string | undefined {
  if (item.id.startsWith('ws-')) return item.title
  if (item.kind !== 'file') return undefined
  const dot = path.lastIndexOf('.')
  return `${item.title.replace(/[\\/:*?"<>|]+/g, '-')}${dot === -1 ? '' : path.slice(dot)}`
}

function iconFor(item: CanvasItem): typeof Code2 {
  if (item.kind === 'code') return Code2
  if (item.kind === 'file') {
    const format = canvasFileFormat(item.versions.at(-1)?.path ?? '')
    if (format === 'xlsx' || format === 'csv') return FileSpreadsheet
    if (format === 'pdf') return FileType2
    if (format === 'image') return ImageIcon
    if (format === undefined) return FileIcon
  }
  return FileText
}

/**
 * Header title that doubles as a canvas picker once a session has more than
 * one canvas. Common since kind:"file" landed: "format về excel" leaves the
 * markdown draft AND the spreadsheet side by side, and before this the panel
 * could only ever show whichever one was written last.
 */
function CanvasSwitcher({ item, items, onPick, onClose }: { item: CanvasItem; items: readonly CanvasItem[]; onPick: (id: string) => void; onClose: (id: string) => void }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const Icon = iconFor(item)
  if (items.length < 2) {
    return (
      <>
        <Icon size={16} className="flex-none text-accent" />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg" title={item.title}>{item.title}</span>
      </>
    )
  }
  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-1">
      <button
        type="button"
        onClick={() => { setOpen(v => !v) }}
        title={t('canvas.switch')}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-bg-hover"
      >
        <Icon size={16} className="flex-none text-accent" />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg">{item.title}</span>
        <span className="flex-none rounded-full bg-bg-raised px-1.5 text-[0.75em] tabular-nums text-muted">{items.length}</span>
        <ChevronDown size={14} className="flex-none text-muted" />
      </button>
      {open ? (
        <div role="listbox" className="absolute left-0 top-full z-30 mt-1 max-h-[320px] w-[min(320px,80vw)] overflow-y-auto rounded-xl border border-border bg-bg p-1 shadow-fh-lv2">
          {items.map((candidate) => {
            const CandidateIcon = iconFor(candidate)
            return (
              // Row = pick button + close "X" side by side (a button can't
              // nest another). The X stays in the menu so several canvases
              // can be tidied away in one go.
              <div
                key={candidate.id}
                className={`group flex items-center rounded-lg hover:bg-bg-hover ${candidate.id === item.id ? 'bg-bg-hover' : ''}`}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={candidate.id === item.id}
                  onClick={() => { onPick(candidate.id); setOpen(false) }}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2.5 pr-1 text-left text-[0.9em]"
                >
                  <CandidateIcon size={15} className="flex-none text-accent" />
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-fg">{candidate.title}</span>
                  <span className="flex-none text-[0.8em] tabular-nums text-muted">v{candidate.versions.length}</span>
                </button>
                <button
                  type="button"
                  title={t('canvas.closeItem', { title: candidate.title })}
                  aria-label={t('canvas.closeItem', { title: candidate.title })}
                  onClick={() => { onClose(candidate.id) }}
                  className="mr-1 flex-none cursor-pointer rounded p-1 text-muted hover:bg-bg-raised hover:text-fg"
                >
                  <X size={13} />
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function CanvasPanel({ sessionId, overlay = false }: { sessionId: string; overlay?: boolean }) {
  const { t } = useLocale()
  const { theme } = useTheme()
  const activeId = useCanvasStore(state => state.activeId)
  const items = useCanvasStore(state => state.items)
  const setCanvasActiveVersion = useCanvasStore(state => state.setActiveVersion)
  const setCanvasActiveId = useCanvasStore(state => state.setActiveId)
  const item = activeId !== undefined ? items[activeId] : undefined
  const allItems = useMemo(() => Object.values(items), [items])

  const [tab, setTab] = useState<Tab>('preview')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  const activeVersion = item?.versions.find(v => v.version === item.activeVersion)
  const versionIndex = item?.versions.findIndex(v => v.version === item.activeVersion) ?? -1
  const previousVersion = item !== undefined && versionIndex > 0 ? item.versions[versionIndex - 1] : undefined
  // A canvas_write with language:"html" (see packages/tool/canvas and
  // prompt.ts's Canvas section — this is the "build a website" path) gets a
  // live-rendered tab alongside its source, the same Preview/Edit split
  // markdown already has, instead of only ever showing highlighted text.
  const isHtml = item !== undefined && item.kind === 'code' && item.language?.toLowerCase() === 'html'
  // kind:"file" (Excel/Word/PDF snapshot): preview-only — no text to edit or
  // copy; changes go through the agent (the tool result tells it to patch
  // the file with the same python library). A version diff exists only
  // between two spreadsheets, cell by cell.
  const isFile = item?.kind === 'file'
  const fileFormat = isFile && activeVersion !== undefined ? canvasFileFormat(activeVersion.path) : undefined
  // A file canvas's id can hold mixed formats (measured: asked for a PDF of
  // an Excel quote, the model reused the same id, so v1 was .xlsx and v2
  // .pdf). Diff against the nearest EARLIER version of the same format, not
  // blindly the previous one, so a later Excel edit still diffs against the
  // last Excel rather than losing the tab to an intervening PDF.
  const previousSheet = (fileFormat === 'xlsx' || fileFormat === 'csv') && item !== undefined
    ? [...item.versions.slice(0, Math.max(0, versionIndex))].reverse().find(v => canvasFileFormat(v.path) === fileFormat)
    : undefined
  const sheetDiffFormat = previousSheet !== undefined && (fileFormat === 'xlsx' || fileFormat === 'csv') ? fileFormat : undefined
  const diffBase = isFile ? previousSheet : previousVersion
  const canDiff = diffBase !== undefined

  // Re-syncs the draft (and picks a sane default tab) whenever the person
  // switches canvases or jumps to a different version — otherwise an
  // in-progress edit on canvas A would leak into canvas B, or a stale draft
  // would silently outlive the version it was based on.
  const versionKey = item !== undefined ? `${item.id}:${String(item.activeVersion)}` : undefined
  useEffect(() => {
    setDraft(activeVersion?.content ?? '')
    setTab(item?.kind === 'markdown' || item?.kind === 'file' || isHtml ? 'preview' : 'edit')
    setSaveError(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionKey])

  if (item === undefined) return null

  const dirty = activeVersion !== undefined && draft !== activeVersion.content

  function jumpVersion(offset: number): void {
    if (item === undefined) return
    const next = item.versions[versionIndex + offset]
    if (next !== undefined) setCanvasActiveVersion(item.id, next.version)
  }

  async function handleSave(): Promise<void> {
    if (item === undefined) return
    setSaving(true)
    setSaveError(undefined)
    try {
      await saveCanvasEdit(sessionId, item.id, draft)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleDownload(): Promise<void> {
    if (item === undefined || activeVersion === undefined) return
    try {
      const blob = await (await fetchCanvasFile(sessionId, activeVersion.path)).blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = downloadName(item, activeVersion.path) ?? activeVersion.path.split('/').pop() ?? 'canvas'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleCopy(): Promise<void> {
    if (activeVersion === undefined) return
    try {
      await navigator.clipboard.writeText(tab === 'edit' ? draft : activeVersion.content)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1500)
    } catch {
      // Clipboard permission denied — no fallback affordance needed for a Copy button.
    }
  }

  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-bg ${overlay ? 'shadow-fh-sm' : ''}`}>
      <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
        <CanvasSwitcher item={item} items={allItems} onPick={(id) => { setCanvasActiveId(id) }} onClose={(id) => { closeCanvas(sessionId, id) }} />
        {item.versions.length > 1 ? (
          <div className="flex flex-none items-center gap-0.5 text-muted">
            <button type="button" title={t('canvas.previousVersion')} disabled={versionIndex <= 0} onClick={() => { jumpVersion(-1) }} className="rounded p-1 hover:bg-bg-hover disabled:opacity-30">
              <ChevronLeft size={14} />
            </button>
            <span className="tabular-nums text-[0.8em]">{t('canvas.versionLabel', { version: String(versionIndex + 1), total: String(item.versions.length) })}</span>
            <button type="button" title={t('canvas.nextVersion')} disabled={versionIndex < 0 || versionIndex >= item.versions.length - 1} onClick={() => { jumpVersion(1) }} className="rounded p-1 hover:bg-bg-hover disabled:opacity-30">
              <ChevronRight size={14} />
            </button>
          </div>
        ) : null}
        {isFile ? null : (
          <button type="button" title={t('canvas.copy')} onClick={() => { void handleCopy() }} disabled={activeVersion === undefined} className="flex-none rounded p-1.5 text-muted hover:bg-bg-hover hover:text-fg disabled:opacity-30">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        )}
        {activeVersion !== undefined ? (
          <button type="button" onClick={() => { void handleDownload() }} title={t('canvas.download')} className="flex-none rounded p-1.5 text-muted hover:bg-bg-hover hover:text-fg">
            <Download size={15} />
          </button>
        ) : null}
        <button type="button" title={t('canvas.close')} onClick={() => { dismissPanel(sessionId) }} className="flex-none rounded p-1.5 text-muted hover:bg-bg-hover hover:text-fg">
          <X size={16} />
        </button>
      </div>

      <div className="flex flex-none items-center gap-1 border-b border-border-subtle px-3 py-1.5 text-[0.8em]">
        {item.kind === 'markdown' || isHtml || isFile ? <TabButton active={tab === 'preview'} onClick={() => { setTab('preview') }}>{t('canvas.tabPreview')}</TabButton> : null}
        {isFile ? null : <TabButton active={tab === 'edit'} onClick={() => { setTab('edit') }}>{t('canvas.tabEdit')}</TabButton>}
        {canDiff ? (
          <TabButton active={tab === 'diff'} onClick={() => { setTab('diff') }}>{t('canvas.tabDiff')}</TabButton>
        ) : null}
        <span className="flex-1" />
        {tab === 'edit' ? (
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => { void handleSave() }}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-medium text-accent-contrast disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            {saving ? t('canvas.saving') : t('canvas.save')}
          </button>
        ) : null}
      </div>

      {saveError !== undefined ? (
        <div className="flex-none border-b border-border-subtle bg-bubble-live px-3 py-1.5 text-[0.8em] text-error">{saveError}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeVersion === undefined ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : tab === 'diff' && previousSheet !== undefined && sheetDiffFormat !== undefined ? (
          <SpreadsheetDiff sessionId={sessionId} beforePath={previousSheet.path} afterPath={activeVersion.path} format={sheetDiffFormat} />
        ) : tab === 'diff' && previousVersion !== undefined && !isFile ? (
          <DiffView before={previousVersion.content} after={activeVersion.content} />
        ) : isFile ? (
          <FilePreview key={`${item.id}:${String(activeVersion.version)}`} sessionId={sessionId} path={activeVersion.path} format={fileFormat} title={item.title} />
        ) : tab === 'preview' && isHtml ? (
          <HtmlPreview key={activeVersion.version} source={activeVersion.content} title={item.title} />
        ) : tab === 'preview' ? (
          <div className="h-full overflow-y-auto overscroll-contain p-4"><div className="assistant-text-body"><Markdown text={activeVersion.content} /></div></div>
        ) : (
          <CodeMirror
            value={draft}
            height="100%"
            theme={theme}
            extensions={extensionsFor(activeVersion.path, item.language)}
            onChange={(value) => { setDraft(value) }}
          />
        )}
      </div>
    </div>
  )
}
