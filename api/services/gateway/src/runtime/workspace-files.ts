// Files in a session's working directory (docs/rlm-transfer-plan.md giai đoạn 4):
// list, upload, download. Only a data-analysis chat or a project has one.
// Paths never leave that directory and hidden paths (.python-session, partial
// uploads, .fox/, .dsh/ skills) are never listed or served. The caller has already checked ownership.
//
// Uploads are recorded in `.fox/sources.json`: only those files are the folder's
// sources; everything else a chat wrote is its output, even outside generated/
// (docs/qa-report-2026-09-15.md N2).

import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { WorkspaceFile } from '../api-types.ts'

import { config } from '../config.ts'

export class UploadTooLargeError extends Error {}

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isHidden(relativePath: string): boolean {
  return relativePath.split(sep).some((part) => part.startsWith('.'))
}

// A client-supplied relative path resolved inside `dir`, or undefined when it
// escapes the directory or names a hidden path.
export function resolveInside(dir: string, relativePath: string): string | undefined {
  const target = resolve(dir, relativePath)
  const inside = relative(dir, target)
  if (!inside || inside.startsWith('..') || isHidden(inside)) return undefined
  return target
}

const SOURCES_FILE = join('.fox', 'sources.json')

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
  const raw = await readFile(join(dir, SOURCES_FILE), 'utf8').catch(() => undefined)
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
  await mkdir(join(dir, '.fox'), { recursive: true })
  const temporary = join(dir, `${SOURCES_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}`)
  await writeFile(temporary, JSON.stringify([...sources].sort()))
  await rename(temporary, join(dir, SOURCES_FILE))
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
    const info = await stat(join(dir, path))
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
  if (!(await stat(source).catch(() => undefined))?.isFile()) return undefined
  await mkdir(join(dir, 'outputs'), { recursive: true })
  await copyFile(source, join(dir, 'outputs', basename(source)))
  return `outputs/${basename(source)}`
}

// `name (2).ext`, `name (3).ext`, ... — the first name not taken in `dir`.
async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`
    if (!(await stat(join(dir, candidate)).catch(() => undefined))) return candidate
  }
  throw new Error('too many files with this name')
}

// Streams the request body to `<dir>/<name>` through a hidden partial file; returns the name it was saved as.
// `unique` (chat attachments): never replace an existing file — an earlier message may refer to it — but save
// under the next free name instead. Without it a re-upload replaces the file (project sources).
export async function saveUpload(dir: string, requested: string, body: IncomingMessage, { unique = false } = {}): Promise<string> {
  await mkdir(dir, { recursive: true })
  const name = unique ? await freeName(dir, requested) : requested
  const target = join(dir, name)
  const partial = join(dir, `.${name}.part`)
  let received = 0
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      done(received > config.maxUploadBytes ? new UploadTooLargeError(`file is larger than ${config.maxUploadBytes} bytes`) : null, chunk)
    },
  })
  try {
    await pipeline(body, limit, createWriteStream(partial))
    await rename(partial, target)
    await updateSources(dir, (sources) => sources.add(name.split(sep).join('/')))
    return name
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
}

/** Removes one visible file of `dir` (and its source record); false when there is no such file. */
export async function deleteWorkspaceFile(dir: string, path: string): Promise<boolean> {
  const target = resolveInside(dir, path)
  const info = target ? await stat(target).catch(() => undefined) : undefined
  if (!target || !info?.isFile()) return false
  await rm(target)
  const recorded = relative(dir, target).split(sep).join('/')
  await updateSources(dir, (sources) => sources.delete(recorded))
  return true
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
