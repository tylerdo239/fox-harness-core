// Files in a session's working directory (docs/rlm-transfer-plan.md giai đoạn 4):
// list, upload, download. Only a data-analysis chat or a project has one.
// Paths never leave that directory and hidden paths (.python-session, partial
// uploads, .fox/, .dsh/ skills) are never listed or served. The caller has already checked ownership.
// Every read, write and delete goes through safe-fs.ts: the model's python can put a symlink in the folder, and
// this process is not sandboxed (docs/workspace-symlink-isolation-plan.md).
//
// Uploads are recorded in `.fox/sources.json`: only those files are the folder's
// sources; everything else a chat wrote is its output, even outside generated/
// (docs/qa-report-2026-09-15.md N2).

import { lstat, mkdir, readdir } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, extname, join, posix, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { WorkspaceFile } from '../api-types.ts'

import { config } from '../config.ts'
import { refreshDatasetCards } from './dataset-cards.ts'
import { createInside, openInside, readTextInside, removeInside, renameInside, writeFileInside } from './safe-fs.ts'

export class UploadTooLargeError extends Error {}

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isHidden(relativePath: string): boolean {
  return relativePath.split(sep).some((part) => part.startsWith('.'))
}

// The canvas panel's snapshots and in-panel edits (app/src/components/features/canvas): hidden, so they never show
// in the file list or count as the folder's sources, but readable by path so the panel can show old versions.
export const CANVAS_DIR = '.canvas'

// A client-supplied relative path resolved inside `dir`, or undefined when it
// escapes the directory or names a hidden path (with `canvas`, a file directly in CANVAS_DIR is allowed).
export function resolveInside(dir: string, relativePath: string, { canvas = false } = {}): string | undefined {
  const target = resolve(dir, relativePath)
  const inside = relative(dir, target)
  if (!inside || inside.startsWith('..')) return undefined
  if (canvas && dirnameOf(inside) === CANVAS_DIR && !basename(inside).startsWith('.')) return target
  if (isHidden(inside)) return undefined
  return target
}

function dirnameOf(path: string): string {
  const parts = path.split(sep)
  return parts.slice(0, -1).join(sep)
}

const SOURCES_FILE = '.fox/sources.json'

// Visible files, `/`-separated paths relative to `dir`.
async function filePaths(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .filter((path) => !isHidden(path))
    .map((path) => path.split(sep).join('/'))
}

// The recorded sources; a folder from before the record gets its current files
// outside generated/ and outputs/ recorded as its sources.
async function sourcesOf(dir: string): Promise<Set<string>> {
  // through safe-fs: python can replace `.fox` with a link to another user's folder
  const raw = await readTextInside(dir, SOURCES_FILE)
  if (raw !== undefined) {
    try {
      return new Set(JSON.parse(raw) as string[])
    } catch {
      // a record broken by concurrent writes before 2026-10-08 (see writeSources): rebuilt below
    }
  }
  const existing = (await filePaths(dir)).filter((path) => !path.startsWith('generated/') && !path.startsWith('outputs/'))
  const sources = new Set(existing)
  await writeSources(dir, sources)
  return sources
}

// Written whole through a temporary file: two uploads finishing together used to interleave their writes and
// leave a broken record (then every file listing failed).
async function writeSources(dir: string, sources: Set<string>): Promise<void> {
  await writeFileInside(dir, SOURCES_FILE, JSON.stringify([...sources].sort()))
}

// One read-change-write of a folder's record at a time (chat attachments upload several files at once).
const sourceUpdates = new Map<string, Promise<unknown>>()
function updateSources(dir: string, change: (sources: Set<string>) => void): Promise<void> {
  const next = (sourceUpdates.get(dir) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const sources = await sourcesOf(dir)
      change(sources)
      await writeSources(dir, sources)
    })
  sourceUpdates.set(dir, next)
  void next.finally(() => {
    if (sourceUpdates.get(dir) === next) sourceUpdates.delete(dir)
  }).catch(() => undefined)
  return next
}

function originOf(path: string, sources: Set<string>): Pick<WorkspaceFile, 'origin' | 'sessionId'> {
  if (sources.has(path)) return { origin: 'source' }
  const parts = path.split('/')
  if (parts[0] === 'outputs') return { origin: 'shared' }
  // generated/<sessionId>/… is that chat's output folder (FOX_OUTPUT_DIR).
  if (parts[0] === 'generated' && parts.length > 2 && PROJECT_ID_RE.test(parts[1]!)) return { origin: 'chat', sessionId: parts[1] }
  return { origin: 'chat' }
}

export async function listWorkspaceFiles(dir: string): Promise<WorkspaceFile[]> {
  const sources = await sourcesOf(dir)
  const files: WorkspaceFile[] = []
  for (const path of await filePaths(dir)) {
    // lstat: a file swapped for a link since the listing must not report the target's size
    const info = await lstat(join(dir, path)).catch(() => undefined)
    if (!info?.isFile()) continue
    files.push({ path, sizeBytes: info.size, modified: info.mtime.toISOString(), ...originOf(path, sources) })
  }
  return files.sort((a, b) => b.modified.localeCompare(a.modified))
}

// "Đưa vào dự án": copies one chat's output `generated/<sessionId>/<path>` into
// the project's shared `outputs/` folder. Returns the new relative path, or
// undefined when there is no such output file of that chat.
export async function promoteOutput(dir: string, sessionId: string, path: string): Promise<string | undefined> {
  if (!PROJECT_ID_RE.test(sessionId)) return undefined
  const chatOutputs = join(dir, 'generated', sessionId)
  const source = resolveInside(dir, join('generated', sessionId, path))
  if (!source || relative(chatOutputs, source).startsWith('..')) return undefined
  const opened = await openInside(dir, relative(dir, source))
  if (!opened) return undefined
  const name = basename(source)
  // through a partial file: an existing outputs/<name> is replaced (a link there too), never written through
  const partial = posix.join('outputs', `.${name}.part`)
  try {
    await removeInside(dir, partial, { anyEntry: true })
    const target = await createInside(dir, partial)
    await pipeline(opened.handle.createReadStream(), target.createWriteStream())
    await renameInside(dir, partial, posix.join('outputs', name))
  } catch (error) {
    await removeInside(dir, partial, { anyEntry: true }).catch(() => undefined)
    throw error
  } finally {
    await opened.handle.close().catch(() => undefined)
  }
  return `outputs/${name}`
}

// `name (2).ext`, `name (3).ext`, ... — the first name not taken in `dir`.
async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`
    // lstat: a symlink under that name (even a broken one) counts as taken
    if (!(await lstat(join(dir, candidate)).catch(() => undefined))) return candidate
  }
  throw new Error('too many files with this name')
}

// Streams the request body to `<dir>/<name>` through a hidden partial file; returns the name it was saved as.
// `unique` (chat attachments): never replace an existing file — an earlier message may refer to it — but save
// under the next free name instead. Without it a re-upload replaces the file (project sources).
// `canvas`: a canvas snapshot or in-panel edit, saved under CANVAS_DIR (never replacing one) and returned as that
// relative path — not one of the folder's sources, so no source record and no dataset card.
export async function saveUpload(dir: string, requested: string, body: IncomingMessage, { unique = false, canvas = false } = {}): Promise<string> {
  await mkdir(dir, { recursive: true })
  // `/`-separated, relative to `dir`: every write below goes through safe-fs
  const base = canvas ? `${CANVAS_DIR}/` : ''
  const name = unique || canvas ? await freeName(join(dir, base), requested) : requested
  const partial = `${base}.${name}.part`
  let received = 0
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      done(received > config.maxUploadBytes ? new UploadTooLargeError(`file is larger than ${config.maxUploadBytes} bytes`) : null, chunk)
    },
  })
  try {
    // a partial left by an earlier upload (or a link put there) is removed, never written through
    await removeInside(dir, partial, { anyEntry: true })
    const file = await createInside(dir, partial)
    await pipeline(body, limit, file.createWriteStream())
    await renameInside(dir, partial, `${base}${name}`)
    if (canvas) return `${CANVAS_DIR}/${name}`
    await updateSources(dir, (sources) => sources.add(name.split(sep).join('/')))
    refreshDatasetCards(dir)
    return name
  } catch (error) {
    await removeInside(dir, partial, { anyEntry: true }).catch(() => undefined)
    throw error
  }
}

/** Removes one visible file of `dir` (and its source record); returns its size, undefined when there is no such file. */
export async function deleteWorkspaceFile(dir: string, path: string): Promise<number | undefined> {
  const target = resolveInside(dir, path)
  if (!target) return undefined
  const recorded = relative(dir, target).split(sep).join('/')
  // a link is not one of the folder's files (never listed): left alone, 404
  const size = await removeInside(dir, recorded)
  if (size === undefined) return undefined
  await updateSources(dir, (sources) => sources.delete(recorded))
  refreshDatasetCards(dir)
  return size
}

// Only inert types are served with their real content type; anything that a
// browser could execute (HTML, SVG, ...) goes out as a plain download.
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}
