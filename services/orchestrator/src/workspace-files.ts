// Files in a session's working directory (docs/rlm-transfer-plan.md giai đoạn 4):
// list, upload, download. Only flows with a `cwd` (config.flows) have one.
// Paths never leave that directory and hidden paths (.python-session, partial
// uploads) are never listed or served. Gateway has already checked ownership.

import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { WorkspaceFile } from '@fox-harness/contracts'

import { config } from './config.ts'
import { getSession } from './redis.ts'

export class UploadTooLargeError extends Error {}

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A project's shared working directory (docs/rlm-transfer-plan.md 9.1); undefined for a malformed id. */
export function projectDirFor(projectId: string): string | undefined {
  return PROJECT_ID_RE.test(projectId) ? join(config.projectsDir, projectId) : undefined
}

export async function workspaceDirFor(sessionId: string): Promise<string | undefined> {
  const record = await getSession(sessionId)
  if (!record || record.status === 'archived') return undefined
  if (record.projectId !== undefined) return projectDirFor(record.projectId)
  const cwd = config.flows[(record.flow ?? 'default') as keyof typeof config.flows]?.cwd
  return cwd === undefined ? undefined : join(record.dshHomeDir, relative('/data', cwd))
}

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

export async function listWorkspaceFiles(dir: string): Promise<WorkspaceFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  const files: WorkspaceFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    const path = relative(dir, full)
    if (isHidden(path)) continue
    const info = await stat(full)
    files.push({ path: path.split(sep).join('/'), sizeBytes: info.size, modified: info.mtime.toISOString() })
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

// Streams the request body to `<dir>/<name>` through a hidden partial file.
export async function saveUpload(dir: string, name: string, body: IncomingMessage): Promise<void> {
  await mkdir(dir, { recursive: true })
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
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
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
