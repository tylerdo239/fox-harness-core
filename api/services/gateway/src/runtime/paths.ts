// Where everything lives on disk, and which of it a request may touch. Every path is built from ids
// that already passed authorization plus a strict UUID check — never from client input — because one
// runtime now serves every user and the filesystem is shared (docs/single-backend-architecture-plan.md §6).

import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { config } from '../config.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: string): boolean => UUID_RE.test(value)

/** The one dsh home all runtimes share: the generated profile, presets, and every session's log. */
export const dshHome = (): string => join(config.dataDir, 'dsh-home')

/** `users/<userId>/<sessionId>`: a chat's own workspace (and the parent of every path it may write). */
export function sessionDir(userId: number, sessionId: string): string {
  if (!Number.isInteger(userId) || userId <= 0 || !isUuid(sessionId)) throw new Error('invalid session path')
  return join(config.dataDir, 'users', String(userId), sessionId)
}

/** A project's shared working directory; undefined for a malformed id. */
export function projectDirFor(projectId: string): string | undefined {
  return isUuid(projectId) ? join(config.dataDir, 'projects', projectId) : undefined
}

export interface SessionPlacement {
  /** The session's working directory (`session.header.cwd`: the sandbox's workspace-write root). */
  cwd: string
  /** Where the python tool saves figures/artifacts, relative to `cwd`; only a project chat has one. */
  outputDir: string | undefined
}

/**
 * A project chat works in the project's shared folder (its outputs go to `generated/<sessionId>`);
 * every other chat in its own folder. The ids come from the database row, not the request.
 */
export function placementFor(info: { ownerId: number; projectId: string | undefined }, sessionId: string): SessionPlacement {
  if (info.projectId !== undefined) {
    const dir = projectDirFor(info.projectId)
    if (!dir) throw new Error('invalid project id')
    return { cwd: dir, outputDir: `generated/${sessionId}` }
  }
  return { cwd: sessionDir(info.ownerId, sessionId), outputDir: undefined }
}

export async function ensurePlacement(placement: SessionPlacement): Promise<void> {
  await mkdir(placement.cwd, { recursive: true })
}

/** `rm -rf dir`, tolerating "already gone". */
export async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/**
 * dsh keeps a session's log under `<dshHome>/sessions/--<cwd>--/<sessionId>/`; the bucket is named after the
 * working directory the session was created in, so a delete has to look in every bucket for the id.
 */
export async function removeSessionLogs(sessionId: string): Promise<void> {
  if (!isUuid(sessionId)) return
  const root = join(dshHome(), 'sessions')
  for (const bucket of await readdir(root).catch(() => [] as string[])) {
    await rm(join(root, bucket, sessionId), { recursive: true, force: true })
  }
}
