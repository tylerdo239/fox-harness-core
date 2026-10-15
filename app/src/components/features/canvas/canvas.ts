// The browser half of the canvas feature (ported from local-fox-harness-core's apps/web lib/canvas.ts; the model's
// half is api/packages/tool/canvas). This module owns the marker a `canvas_write` result carries
// (`<!--fox-canvas:{...}-->`) and the glue that turns a marker into panel state, or a panel edit into a saved file.
//
// Not React: it runs from the conversation's event handling and from button handlers, so it reads and writes
// useCanvasStore directly. Files go through the gateway's workspace files route of the session
// (`/sessions/<id>/files/...`); snapshots and in-panel edits are uploaded with `purpose=canvas`, which keeps them
// in the folder's hidden .canvas/ directory — never in the file list, never one of the folder's sources.

import { useCanvasStore, type CanvasVersion } from './store.ts'

export type CanvasKind = 'code' | 'markdown' | 'file'

// What a file canvas can preview, by extension; `undefined` = download only.
export type CanvasFileFormat = 'xlsx' | 'csv' | 'docx' | 'pdf' | 'image'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function canvasFileFormat(path: string): CanvasFileFormat | undefined {
  const ext = extensionOf(path)
  if (ext === 'xlsx' || ext === 'csv' || ext === 'docx' || ext === 'pdf') return ext
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : undefined
}

/** Excel/Word/PDF — the deliverables the end-of-turn auto-open reacts to (an image or a script written on the way is not "the result"). */
export function isOfficeDeliverable(path: string): boolean {
  const format = canvasFileFormat(path)
  return format !== undefined && format !== 'image'
}

// Plain-text files a click opens as a text canvas; the value is the CodeMirror language ('' = none).
const TEXT_LANGUAGES: Record<string, string> = {
  md: 'markdown', markdown: 'markdown', txt: '', log: '', text: '',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx', ts: 'typescript', tsx: 'tsx', json: 'json', py: 'python', sql: 'sql', yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', xml: 'xml', toml: 'toml', ini: '', cfg: '', conf: '', tsv: '',
}
const TEXT_BASENAMES = new Set(['dockerfile', 'makefile', 'readme', 'license'])
// A text canvas holds its content in memory (and in CodeMirror); past this a file opens download-only.
const MAX_TEXT_CANVAS_BYTES = 2 * 1024 * 1024

export interface CanvasMarker {
  readonly id: string
  readonly kind: CanvasKind
  readonly title: string
  readonly language?: string
  readonly path: string
  readonly version: number
}

interface MarkerContentBlock { readonly type?: string; readonly text?: string }
interface MarkerResultBlock { readonly content?: readonly MarkerContentBlock[] }

// One flat JSON object; the parser checks every field rather than trusting text a model could echo back.
const MARKER_RE = /<!--fox-canvas:(\{.*?\})-->/

/** The tool-result text without its machine-facing marker. */
export function stripCanvasMarker(text: string): string {
  return text.replace(MARKER_RE, '').trimEnd()
}

/** A `tool/result` event's canvas marker, or undefined when it carries none. */
export function parseCanvasMarker(event: { type: string; data: unknown }): CanvasMarker | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data as { message?: { content?: readonly MarkerResultBlock[] } }
  const text = (data.message?.content?.[0]?.content ?? [])
    .filter((b): b is { type: string; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
  const match = MARKER_RE.exec(text)
  if (match?.[1] === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(match[1]) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const c = parsed as Record<string, unknown>
  if (
    typeof c.id !== 'string'
    || (c.kind !== 'code' && c.kind !== 'markdown' && c.kind !== 'file')
    || typeof c.title !== 'string'
    || typeof c.path !== 'string'
    || typeof c.version !== 'number'
  ) return undefined
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    ...(typeof c.language === 'string' ? { language: c.language } : {}),
    path: c.path,
    version: c.version,
  }
}

function filesBase(sessionId: string): string {
  return `/sessions/${sessionId}/files`
}

/** GET one file of the session's working directory (or its .canvas/ snapshots). */
export async function fetchCanvasFile(sessionId: string, path: string): Promise<Response> {
  const fetch = useCanvasStore.getState().fetch
  if (fetch === undefined) throw new Error('canvas is not connected')
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const response = await fetch(`${filesBase(sessionId)}/${encoded}`)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response
}

/** Stores bytes as a hidden canvas snapshot; returns the path the gateway saved it under (`.canvas/…`). */
async function uploadCanvasSnapshot(sessionId: string, name: string, body: Blob | string): Promise<string> {
  const fetch = useCanvasStore.getState().fetch
  if (fetch === undefined) throw new Error('canvas is not connected')
  const response = await fetch(`${filesBase(sessionId)}?name=${encodeURIComponent(name)}&purpose=canvas`, { method: 'POST', body })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return ((await response.json()) as { path: string }).path
}

/**
 * Applies one marker: upsert the canvas, open the panel on it, fetch its text unless that version is cached.
 * Called for every `tool/result` carrying a marker, live or replayed from the snapshot, so a reload rebuilds the
 * panel from the session itself. `seq` is the event's seq (see the panel-dismissal note below); reopenCanvas
 * passes Infinity — an explicit click always reopens.
 */
export function applyCanvasMarker(sessionId: string, marker: CanvasMarker, seq: number): void {
  // Closed with the switcher's X: a replay does not bring it back, only a NEWER version does.
  const dismissed = dismissedVersion(sessionId, marker.id)
  if (dismissed !== undefined) {
    if (marker.version <= dismissed) return
    setDismissed(sessionId, marker.id, undefined)
  }
  const store = useCanvasStore.getState()
  const existing = store.items[marker.id]
  store.upsertItem(marker.id, { kind: marker.kind, title: marker.title, language: marker.language })
  store.setActiveId(marker.id)
  // The header's X recorded the last seq it had seen: a replayed marker at or below it does not force the panel
  // open again on reload; a marker after it (the model wrote again) does.
  const panelDismissed = panelDismissedSeq(sessionId)
  if (panelDismissed === undefined || seq > panelDismissed) store.setOpen(true)
  if (existing?.versions.some((v) => v.version === marker.version)) {
    store.setActiveVersion(marker.id, marker.version)
    return
  }
  if (marker.kind === 'file') {
    store.upsertVersion(marker.id, { version: marker.version, path: marker.path, content: '', source: 'model' })
    store.setActiveVersion(marker.id, marker.version)
    return
  }
  void fetchCanvasFile(sessionId, marker.path)
    .then((response) => response.text())
    .then((content) => {
      const now = useCanvasStore.getState()
      if (now.sessionId !== sessionId) return
      now.upsertVersion(marker.id, { version: marker.version, path: marker.path, content, source: 'model' })
      // Fetches can resolve out of order: never drag the panel back to an older version.
      const active = now.items[marker.id]?.activeVersion ?? 0
      if (marker.version >= active) now.setActiveVersion(marker.id, marker.version)
    })
    .catch(() => {
      // Transient (the workspace is being restored); this version just has no content yet.
    })
}

/** Records a marker as it arrives (for reopenCanvas) and applies it. */
export function receiveCanvasMarker(sessionId: string, marker: CanvasMarker, seq: number): void {
  useCanvasStore.setState((state) => ({ markers: [...state.markers, { marker, seq }] }))
  applyCanvasMarker(sessionId, marker, seq)
}

/** Saves an edit made in the panel as the next version (a hidden snapshot; nothing appears in the file list). */
export async function saveCanvasEdit(sessionId: string, id: string, content: string): Promise<void> {
  const item = useCanvasStore.getState().items[id]
  const latest = item?.versions.at(-1)
  if (item === undefined || latest === undefined) throw new Error(`no existing version for canvas "${id}"`)
  const dot = latest.path.lastIndexOf('.')
  const ext = dot === -1 ? '' : latest.path.slice(dot)
  const nextVersion = Math.max(...item.versions.map((version) => version.version), 0) + 1
  const stored = await uploadCanvasSnapshot(sessionId, `canvas-${id}-${Date.now()}${ext}`, content)
  const version: CanvasVersion = { version: nextVersion, path: stored, content, source: 'user' }
  useCanvasStore.getState().upsertVersion(id, version)
  useCanvasStore.getState().setActiveVersion(id, nextVersion)
}

/** Stable canvas id for a workspace file: `ws-<ascii slug>-<hash>`. */
function workspaceCanvasId(path: string): string {
  const stem = path.replace(/\.[^./]+$/, '')
  const slug = stem.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'file'
  let hash = 0
  for (const ch of path) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `ws-${slug}-${(hash % 0xffff).toString(16).padStart(4, '0')}`
}

/**
 * Opens a workspace file in the panel (a click in the file list, or the end-of-turn auto-open). Text opens as an
 * editable text canvas; Office/PDF/images are snapshotted per distinct mtime into .canvas/ — the model rewrites
 * files in place, so pointing versions at the live file would make every version show the newest bytes and the
 * diff tab report "no changes"; anything else opens as a download-only canvas on the file itself.
 */
export async function openWorkspaceFileInCanvas(sessionId: string, file: { path: string; modified: number; size: number }): Promise<void> {
  const id = workspaceCanvasId(file.path)
  const store = useCanvasStore.getState()
  const latest = store.items[id]?.versions.at(-1)
  const title = file.path.split('/').pop() ?? file.path
  const ext = extensionOf(file.path)
  const format = canvasFileFormat(file.path)
  const textLanguage = TEXT_LANGUAGES[ext] ?? (TEXT_BASENAMES.has(title.toLowerCase()) ? '' : undefined)
  const show = (): void => {
    const now = useCanvasStore.getState()
    now.setActiveVersion(id, now.items[id]?.versions.at(-1)?.version ?? 1)
    now.setActiveId(id)
    now.setOpen(true)
  }

  if (textLanguage !== undefined && format === undefined && file.size <= MAX_TEXT_CANVAS_BYTES) {
    const kind = textLanguage === 'markdown' ? 'markdown' : 'code'
    store.upsertItem(id, { kind, title, ...(textLanguage === '' || kind === 'markdown' ? {} : { language: textLanguage }) })
    if (latest?.modified !== file.modified) {
      const content = await (await fetchCanvasFile(sessionId, file.path)).text()
      useCanvasStore.getState().upsertVersion(id, { version: (latest?.version ?? 0) + 1, path: file.path, content, source: 'model', modified: file.modified })
    }
    show()
    return
  }

  store.upsertItem(id, { kind: 'file', title })
  if (format === undefined) {
    if (latest?.modified !== file.modified) {
      store.upsertVersion(id, { version: (latest?.version ?? 0) + 1, path: file.path, content: '', source: 'model', modified: file.modified })
    }
    show()
    return
  }
  if (latest?.modified !== file.modified) {
    const bytes = await (await fetchCanvasFile(sessionId, file.path)).blob()
    const stored = await uploadCanvasSnapshot(sessionId, `canvas-${id}-${Date.now()}${ext === '' ? '' : `.${ext}`}`, bytes)
    useCanvasStore.getState().upsertVersion(id, { version: (latest?.version ?? 0) + 1, path: stored, content: '', source: 'model', modified: file.modified })
  }
  show()
}

/** Number of file-canvas versions the model attached itself — a turn that grew it needs no auto-open. */
export function fileCanvasVersionCount(): number {
  return Object.values(useCanvasStore.getState().items)
    .filter((item) => item.kind === 'file' && !item.id.startsWith('ws-'))
    .reduce((sum, item) => sum + item.versions.length, 0)
}

// ── Closing canvases ── remembered per browser (a view preference, like the panel width), keyed session:id → the
// highest version that was on screen when closed.
const STORAGE_CANVAS_DISMISSED = 'fox-harness/canvasDismissed'
const STORAGE_PANEL_DISMISSED = 'fox-harness/canvasPanelDismissed'

function readJson(key: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeJson(key: string, value: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable (private mode): closing still works for this page view.
  }
}

function dismissedVersion(sessionId: string, id: string): number | undefined {
  const value = readJson(STORAGE_CANVAS_DISMISSED)[`${sessionId}:${id}`]
  return typeof value === 'number' ? value : undefined
}

function setDismissed(sessionId: string, id: string, version: number | undefined): void {
  const all = readJson(STORAGE_CANVAS_DISMISSED)
  if (version === undefined) delete all[`${sessionId}:${id}`]
  else all[`${sessionId}:${id}`] = version
  writeJson(STORAGE_CANVAS_DISMISSED, all)
}

/** The switcher's X: removes one canvas and keeps it closed across reloads. */
export function closeCanvas(sessionId: string, id: string): void {
  const item = useCanvasStore.getState().items[id]
  if (item === undefined) return
  // Workspace-opened canvases (ws-…) are never replayed from history: nothing to remember.
  if (!id.startsWith('ws-')) setDismissed(sessionId, id, Math.max(0, ...item.versions.map((v) => v.version)))
  useCanvasStore.getState().removeItem(id)
}

/** A chat chip for a canvas that was closed: forget the dismissal and rebuild it from the session's markers. */
export function reopenCanvas(sessionId: string, id: string): void {
  setDismissed(sessionId, id, undefined)
  for (const { marker } of useCanvasStore.getState().markers) {
    if (marker.id === id) applyCanvasMarker(sessionId, marker, Infinity)
  }
}

function panelDismissedSeq(sessionId: string): number | undefined {
  const value = readJson(STORAGE_PANEL_DISMISSED)[sessionId]
  return typeof value === 'number' ? value : undefined
}

/** The panel header's X: hides the panel, and a reload's replay does not reopen it (a newer marker still does). */
export function dismissPanel(sessionId: string): void {
  const state = useCanvasStore.getState()
  state.setOpen(false)
  const all = readJson(STORAGE_PANEL_DISMISSED)
  all[sessionId] = state.lastSeq
  writeJson(STORAGE_PANEL_DISMISSED, all)
}
