// docs/canvas-storage-plan.md — the canvas panel's own history in a working directory's hidden `.canvas/` folder:
// snapshots of a workspace file opened in the panel (an Excel/Word/PDF/image the model rewrites in place) and the
// edits a user saves there. The model's own versions (`canvas-<id>-vN.<ext>`, visible files, named in the chat's
// markers) are not part of it.
//
// `.canvas/index.json` lists them per canvas; it is written by this module only, travels with the folder (archive,
// restore, purge) like the files it describes, and is the one source of truth: a file in `.canvas/` that it does not
// name is removed. Every read and write goes through safe-fs.ts — the model's python can write into the folder.
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { config } from '../config.ts'
import { log } from '../log.ts'
import { createInside, openInside, readTextInside, removeInside, renameInside, writeFileInside } from './safe-fs.ts'
import { deleteFiles, dirUsage } from './workspace-archive.ts'
import { CANVAS_DIR } from './workspace-files.ts'

const INDEX = `${CANVAS_DIR}/index.json`
/** A file in `.canvas/` that no index names is removed once it is this old (an upload may not be indexed yet). */
const ORPHAN_AGE_MS = 10 * 60 * 1000

export const CANVAS_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/
/** A model version: `canvas-<id>-v<N>.<ext>` anywhere among the visible files (the canvas tool's naming). */
const MODEL_VERSION_RE = /(?:^|\/)canvas-([a-z0-9][a-z0-9-]*)-v(\d+)\.[^/]+$/

export interface HistoryEntry {
  version: number
  path: string
  source: 'user' | 'snapshot'
  at: string
  bytes: number
  /** a snapshot: the workspace file it was taken of */
  of?: string
}

interface CanvasIndex {
  v: 1
  canvases: Record<string, HistoryEntry[]>
}

async function readIndex(dir: string): Promise<CanvasIndex> {
  const raw = await readTextInside(dir, INDEX).catch(() => undefined)
  const empty: CanvasIndex = { v: 1, canvases: {} }
  if (raw === undefined) return empty
  try {
    const parsed = JSON.parse(raw) as { canvases?: unknown }
    if (!parsed.canvases || typeof parsed.canvases !== 'object') return empty
    const canvases: CanvasIndex['canvases'] = {}
    // python can write here: keep only well-formed entries that point into `.canvas/`
    for (const [id, entries] of Object.entries(parsed.canvases as Record<string, unknown>)) {
      if (!CANVAS_ID_RE.test(id) || !Array.isArray(entries)) continue
      const kept = entries.filter((e): e is HistoryEntry =>
        !!e && typeof e === 'object' &&
        Number.isInteger((e as HistoryEntry).version) &&
        typeof (e as HistoryEntry).path === 'string' && isHistoryPath((e as HistoryEntry).path) &&
        ((e as HistoryEntry).source === 'user' || (e as HistoryEntry).source === 'snapshot'))
      if (kept.length > 0) canvases[id] = kept
    }
    return { v: 1, canvases }
  } catch {
    return empty
  }
}

/** A file directly in `.canvas/` (not the index, not a partial). */
function isHistoryPath(path: string): boolean {
  const parts = path.split('/')
  return parts.length === 2 && parts[0] === CANVAS_DIR && parts[1] !== 'index.json' && !parts[1]!.startsWith('.') && parts[1] !== ''
}

// One read-change-write of a folder's index at a time.
const updates = new Map<string, Promise<unknown>>()

/**
 * Changes the index, then keeps it within bounds: at most CANVAS_HISTORY_MAX entries per canvas (the oldest go),
 * and no file in `.canvas/` the index does not name (older than ORPHAN_AGE_MS). Removed files go from the disk and S3.
 */
function withIndex<T>(dir: string, change: (index: CanvasIndex) => T | Promise<T>): Promise<T> {
  const next = (updates.get(dir) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const index = await readIndex(dir)
      const result = await change(index)
      const drop = new Set<string>()
      const max = Math.max(1, config.storage.canvasHistoryMax)
      for (const [id, entries] of Object.entries(index.canvases)) {
        entries.sort((a, b) => a.version - b.version)
        while (entries.length > max) drop.add(entries.shift()!.path)
        if (entries.length === 0) delete index.canvases[id]
      }
      const named = new Set(Object.values(index.canvases).flat().map((e) => e.path))
      const now = Date.now()
      for (const file of (await dirUsage(dir)).files) {
        if (isHistoryPath(file.path) && !named.has(file.path) && now - file.mtimeMs > ORPHAN_AGE_MS) drop.add(file.path)
      }
      for (const path of named) drop.delete(path)
      await writeFileInside(dir, INDEX, JSON.stringify(index))
      if (drop.size > 0) {
        const freed = await deleteFiles(dir, (path) => drop.has(path))
        log('canvas_history_pruned', { dir: dir.split('/').slice(-2).join('/'), files: freed.files, bytes: freed.bytes })
      }
      return result
    })
  updates.set(dir, next)
  void next.finally(() => {
    if (updates.get(dir) === next) updates.delete(dir)
  }).catch(() => undefined)
  return next
}

/** GET …/canvas: every canvas's history entries, oldest first. */
export async function canvasHistory(dir: string): Promise<CanvasIndex['canvases']> {
  return (await readIndex(dir)).canvases
}

export type SnapshotResult =
  | { ok: true; created: boolean; entry: HistoryEntry }
  | { ok: false; status: number; body: Record<string, unknown> }

/**
 * Snapshots a visible workspace file into `.canvas/` for canvas `id`, server-side. The name comes from the file
 * itself (path, mtime, size): the same file in the same state is never copied twice, however often it is opened.
 * `check` is the quota check for the bytes it would add.
 */
export async function snapshotFile(
  dir: string,
  path: string,
  id: string,
  check: (bytes: number) => Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }>,
): Promise<SnapshotResult> {
  const opened = await openInside(dir, path)
  if (!opened) return { ok: false, status: 404, body: { error: 'file not found' } }
  try {
    const name = `s-${createHash('sha1').update(path).digest('hex').slice(0, 12)}-${Math.floor(opened.info.mtimeMs)}-${opened.info.size}${extname(path).toLowerCase()}`
    const target = `${CANVAS_DIR}/${name}`
    const existing = await openInside(dir, target)
    if (existing) {
      await existing.handle.close()
      const entry = await withIndex(dir, (index) => {
        const entries = (index.canvases[id] ??= [])
        let found = entries.find((e) => e.path === target)
        if (!found) {
          found = { version: nextVersion(entries), path: target, source: 'snapshot', at: new Date().toISOString(), bytes: opened.info.size, of: path }
          entries.push(found)
        }
        return found
      })
      return { ok: true, created: false, entry }
    }
    const decision = await check(opened.info.size)
    if (!decision.ok) return decision
    const partial = `${CANVAS_DIR}/.${name}.part`
    await removeInside(dir, partial, { anyEntry: true })
    const out = await createInside(dir, partial)
    try {
      await pipeline(opened.handle.createReadStream({ autoClose: false }), out.createWriteStream())
      await renameInside(dir, partial, target)
    } catch (error) {
      await removeInside(dir, partial, { anyEntry: true }).catch(() => undefined)
      throw error
    }
    const entry = await withIndex(dir, (index) => {
      const entries = (index.canvases[id] ??= [])
      const added: HistoryEntry = { version: nextVersion(entries), path: target, source: 'snapshot', at: new Date().toISOString(), bytes: opened.info.size, of: path }
      entries.push(added)
      return added
    })
    return { ok: true, created: true, entry }
  } finally {
    await opened.handle.close().catch(() => undefined)
  }
}

const nextVersion = (entries: HistoryEntry[]) => Math.max(0, ...entries.map((e) => e.version)) + 1

/** A user's edit, already saved (saveUpload `canvas`) at `path`: recorded as `version` of canvas `id`. */
export function recordEdit(dir: string, id: string, path: string, version: number, bytes: number): Promise<HistoryEntry> {
  return withIndex(dir, (index) => {
    const entries = (index.canvases[id] ??= []).filter((e) => e.version !== version)
    const entry: HistoryEntry = { version, path, source: 'user', at: new Date().toISOString(), bytes }
    entries.push(entry)
    index.canvases[id] = entries
    return entry
  })
}

export interface ModelCanvas {
  id: string
  versions: number
  bytes: number
  /** the newest version's path */
  latest: string
}

/** The model's canvas versions among a folder's visible files, grouped per canvas id. */
export function modelCanvases(files: { path: string; size: number }[]): { canvases: ModelCanvas[]; versionPaths: Set<string> } {
  const byId = new Map<string, { version: number; path: string; size: number }[]>()
  for (const file of files) {
    const match = MODEL_VERSION_RE.exec(file.path)
    if (!match) continue
    const list = byId.get(match[1]!) ?? []
    list.push({ version: Number(match[2]), path: file.path, size: file.size })
    byId.set(match[1]!, list)
  }
  const canvases: ModelCanvas[] = []
  const versionPaths = new Set<string>()
  for (const [id, list] of byId) {
    list.sort((a, b) => a.version - b.version)
    for (const v of list) versionPaths.add(v.path)
    canvases.push({ id, versions: list.length, bytes: list.reduce((sum, v) => sum + v.size, 0), latest: list.at(-1)!.path })
  }
  return { canvases: canvases.sort((a, b) => b.bytes - a.bytes), versionPaths }
}

/** `.canvas/` usage of a folder: its files (the index included) and bytes. */
export function historyUsage(files: { path: string; size: number }[]): { files: number; bytes: number } {
  const history = files.filter((f) => f.path.startsWith(`${CANVAS_DIR}/`))
  return { files: history.length, bytes: history.reduce((sum, f) => sum + f.size, 0) }
}

/** "Xoá lịch sử": the whole `.canvas/` (index included). Originals and the model's versions stay. */
export function clearHistory(dir: string): Promise<{ files: number; bytes: number }> {
  return deleteFiles(dir, (path) => path.startsWith(`${CANVAS_DIR}/`))
}

/** One history file (a version in the panel): gone from the index, the disk and S3. Undefined when unknown. */
export async function deleteHistoryFile(dir: string, path: string): Promise<{ files: number; bytes: number } | undefined> {
  if (!isHistoryPath(path)) return undefined
  return withIndex(dir, async (index) => {
    for (const [id, entries] of Object.entries(index.canvases)) index.canvases[id] = entries.filter((e) => e.path !== path)
    const freed = await deleteFiles(dir, (p) => p === path)
    return freed.files > 0 ? freed : undefined
  })
}

/**
 * A model canvas's versions (`canvas-<id>-vN`): every one, or all but the newest (`keepLatest`). Deleting every one
 * also drops that canvas's own history (the user's edits and snapshots of it).
 */
export async function deleteCanvas(dir: string, id: string, { keepLatest }: { keepLatest: boolean }): Promise<{ files: number; bytes: number }> {
  const { files } = await dirUsage(dir)
  const own = files.filter((f) => MODEL_VERSION_RE.exec(f.path)?.[1] === id)
  const newest = Math.max(0, ...own.map((f) => Number(MODEL_VERSION_RE.exec(f.path)![2])))
  const targets = new Set(own.filter((f) => !keepLatest || Number(MODEL_VERSION_RE.exec(f.path)![2]) !== newest).map((f) => f.path))
  if (!keepLatest) {
    return withIndex(dir, async (index) => {
      for (const entry of index.canvases[id] ?? []) targets.add(entry.path)
      delete index.canvases[id]
      return deleteFiles(dir, (path) => targets.has(path))
    })
  }
  return deleteFiles(dir, (path) => targets.has(path))
}

