// docs/workspace-archive-plan.md — the files of every working directory (uploads, what python and the agent wrote)
// copied to S3 under `files/<dirKey>/<path>`, where dirKey is `users/<userId>/<sessionId>` (a chat's own folder) or
// `projects/<projectId>` (a project's shared folder). Same shape as session-archive.ts for the logs: the disk stays
// the working copy (python and bash read files there), a sweep uploads what changed and deletes on S3 what was
// deleted on the disk, a directory untouched for SESSION_LOCAL_RETENTION_DAYS (and fully archived) leaves the disk,
// opening it again downloads it first, and deleting the chat or project deletes every copy. Nothing expires on S3.
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'

import { config } from '../config.ts'
import { getProjectOwnerId, getSessionOwnerId } from '../db.ts'
import { errorFields, log } from '../log.ts'
import { deleteArchiveObject, deleteArchivePrefix, downloadArchiveObject, listArchiveKeys, putArchiveObject } from '../object-storage.ts'
import {
  dropWorkspaceStamps,
  forgetWorkspace,
  isWorkspaceEvicted,
  setWorkspaceEvicted,
  setWorkspaceStamp,
  workspaceStamps,
} from '../redis.ts'
import { isUuid, removeTree } from './paths.ts'

const PREFIX = 'files/'
// a file still being written is left for the next sweep
const SETTLE_MS = 5_000
// Not archived: `.dsh/` is the user's skills, written again from S3 on every connect; `.python-session` a marker;
// caches. A partial upload (`.<name>.part`), a half-written sources record and a half-restored file are temporary.
const SKIPPED_DIRS = new Set(['.dsh', '.python-session', '__pycache__', '.ipynb_checkpoints'])
const TEMPORARY = /^\..+\.(part|restore)$|^sources\.json\.\d+\.\w+$/

const enabled = () => config.sessionArchive.enabled
const objectKey = (dirKey: string, path: string) => `${PREFIX}${dirKey}/${path}`
const stampOf = (info: { mtimeMs: number; size: number }) => `${Math.floor(info.mtimeMs)}:${info.size}`

/** `users/<userId>/<sessionId>` or `projects/<projectId>` for a working directory under the data dir, else undefined. */
export function dirKeyOf(dir: string): string | undefined {
  const parts = relative(config.dataDir, dir).split(sep)
  if (parts.length === 3 && parts[0] === 'users' && /^[1-9]\d*$/.test(parts[1]) && isUuid(parts[2])) return parts.join('/')
  if (parts.length === 2 && parts[0] === 'projects' && isUuid(parts[1])) return parts.join('/')
  return undefined
}

function skipped(path: string): boolean {
  const parts = path.split('/')
  return parts.some((part) => SKIPPED_DIRS.has(part)) || TEMPORARY.test(parts[parts.length - 1])
}

interface WorkspaceFile {
  path: string // `/`-separated, relative to the directory
  full: string
  mtimeMs: number
  size: number
}

async function filesOf(dir: string): Promise<WorkspaceFile[]> {
  const out: WorkspaceFile[] = []
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    const path = relative(dir, full).split(sep).join('/')
    if (skipped(path)) continue
    const info = await stat(full).catch(() => undefined)
    if (info) out.push({ path, full, mtimeMs: info.mtimeMs, size: info.size })
  }
  return out
}

/** Every working directory on the disk that still belongs to a chat or project. */
async function workspaceDirs(): Promise<{ dirKey: string; dir: string }[]> {
  const out: { dirKey: string; dir: string }[] = []
  const usersRoot = join(config.dataDir, 'users')
  for (const userId of await readdir(usersRoot).catch(() => [] as string[])) {
    for (const sessionId of await readdir(join(usersRoot, userId)).catch(() => [] as string[])) {
      const dir = join(usersRoot, userId, sessionId)
      const dirKey = dirKeyOf(dir)
      // a folder of a deleted chat (or not a chat at all) is never uploaded
      if (dirKey && (await getSessionOwnerId(sessionId)) === Number(userId)) out.push({ dirKey, dir })
    }
  }
  const projectsRoot = join(config.dataDir, 'projects')
  for (const projectId of await readdir(projectsRoot).catch(() => [] as string[])) {
    const dir = join(projectsRoot, projectId)
    const dirKey = dirKeyOf(dir)
    if (dirKey && (await getProjectOwnerId(projectId)) !== undefined) out.push({ dirKey, dir })
  }
  return out
}

let sweeping: Promise<void> | undefined

/** One pass over every working directory: upload changed files, delete removed ones, evict old directories. */
export function sweepWorkspaces(): Promise<void> {
  sweeping ??= (async () => {
    const now = Date.now()
    const retentionMs = config.sessionArchive.localRetentionDays * 86_400_000
    const maxBytes = config.sessionArchive.maxFileBytes
    let uploaded = 0
    let bytes = 0
    let removed = 0
    let evicted = 0
    let tooLarge = 0
    const dirs = new Set<string>()
    // one line per pass, not per file: while S3 is down every file fails the same way
    let failed = 0
    let firstFailure: { dirKey: string; path: string; error: unknown } | undefined

    for (const { dirKey, dir } of await workspaceDirs()) {
      // its files are on S3 only: what is on the disk now (the skills a connect writes) says nothing about them
      if (await isWorkspaceEvicted(dirKey)) continue
      const stamps = await workspaceStamps(dirKey)
      const files = await filesOf(dir)
      let allArchived = true
      let newest = 0
      for (const f of files) {
        newest = Math.max(newest, f.mtimeMs)
        if (stamps[f.path] === stampOf(f)) continue
        if (now - f.mtimeMs < SETTLE_MS) {
          allArchived = false
          continue
        }
        if (f.size > maxBytes) {
          // kept on the disk only, so its directory is never evicted
          tooLarge += 1
          allArchived = false
          continue
        }
        try {
          await putArchiveObject(objectKey(dirKey, f.path), await readFile(f.full))
          await setWorkspaceStamp(dirKey, f.path, stampOf(f))
          uploaded += 1
          bytes += f.size
          dirs.add(dirKey)
        } catch (error) {
          failed += 1
          firstFailure ??= { dirKey, path: f.path, error }
          allArchived = false
        }
      }
      // deleted on the disk (by the user or by the chat) → deleted on S3
      const present = new Set(files.map((f) => f.path))
      const gone = Object.keys(stamps).filter((path) => !present.has(path))
      for (const path of gone) {
        try {
          await deleteArchiveObject(objectKey(dirKey, path))
          await dropWorkspaceStamps(dirKey, [path])
          removed += 1
        } catch (error) {
          failed += 1
          firstFailure ??= { dirKey, path, error }
        }
      }
      // marked before it is removed: a crash half-way still leaves it to be restored
      if (retentionMs > 0 && files.length > 0 && allArchived && now - newest > retentionMs) {
        await setWorkspaceEvicted(dirKey, true)
        await removeTree(dir)
        evicted += 1
      }
    }

    if (uploaded > 0 || removed > 0 || evicted > 0) {
      log('workspace_archive', { uploaded, dirs: dirs.size, bytes, ms: Date.now() - now, deleted: removed, evictedFromDisk: evicted })
    }
    if (tooLarge > 0) log('workspace_archive_too_large', { files: tooLarge, maxBytes, hint: 'kept on the disk only; raise WORKSPACE_ARCHIVE_MAX_FILE_BYTES' }, 'warn')
    if (firstFailure) {
      log('workspace_archive_failed', {
        failedFiles: failed,
        uploaded,
        firstDir: firstFailure.dirKey,
        firstPath: firstFailure.path,
        ...errorFields(firstFailure.error),
      })
    }
  })().finally(() => {
    sweeping = undefined
  })
  return sweeping
}

const restoring = new Map<string, Promise<void>>()

/**
 * Before a working directory is used (a chat connects, the files panel opens): if its files left the disk, bring
 * them back from S3. `checkEmpty` also asks S3 when the directory is merely empty — the eviction mark lives in Redis,
 * which is not backed up. Files already on the disk are kept.
 */
export async function ensureWorkspaceLocal(dir: string, { checkEmpty = false } = {}): Promise<void> {
  const dirKey = dirKeyOf(dir)
  if (!enabled() || !dirKey) return
  const evicted = await isWorkspaceEvicted(dirKey)
  if (!evicted && !(checkEmpty && (await filesOf(dir)).length === 0)) return
  let running = restoring.get(dirKey)
  if (!running) {
    running = restore(dirKey, dir, evicted).finally(() => restoring.delete(dirKey))
    restoring.set(dirKey, running)
  }
  return running
}

async function restore(dirKey: string, dir: string, evicted: boolean): Promise<void> {
  const started = Date.now()
  const prefix = `${PREFIX}${dirKey}/`
  const keys = await listArchiveKeys(prefix)
  let files = 0
  let bytes = 0
  for (const key of keys) {
    const path = key.slice(prefix.length)
    // only what this module writes: a relative path that stays inside the directory
    const normal = posix.normalize(path)
    if (!path || normal !== path || path.startsWith('/') || path.split('/').includes('..')) continue
    const full = join(dir, ...path.split('/'))
    if (await stat(full).catch(() => undefined)) continue
    await mkdir(dirname(full), { recursive: true })
    await downloadArchiveObject(key, full)
    const info = await stat(full)
    await setWorkspaceStamp(dirKey, path, stampOf(info))
    files += 1
    bytes += info.size
  }
  if (evicted) await setWorkspaceEvicted(dirKey, false)
  if (files > 0) log('workspace_restored', { dir: dirKey, files, bytes, ms: Date.now() - started })
}

/** Right to erasure: every copy of the directory's files on S3, and what Redis knew about them. */
export async function deleteWorkspaceArchive(dir: string): Promise<void> {
  const dirKey = dirKeyOf(dir)
  if (!enabled() || !dirKey) return
  await deleteArchivePrefix(`${PREFIX}${dirKey}/`)
  await forgetWorkspace(dirKey)
}
