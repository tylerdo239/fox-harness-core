// docs/storage-quota-plan.md — keeping a fixed-size bucket (no lifecycle rule allowed on it) from filling up:
// a per-user quota on files (uploads and chat outputs), checked before every upload; what a user stores, so they
// can delete what they no longer need; and deleting the files of chats and projects unused for N days — on a
// schedule (FILE_RETENTION_DAYS) or when an admin asks (POST /admin/storage/cleanup). Chat logs are not counted
// (a few KB each) and never deleted here.
import { config } from '../config.ts'
import {
  getProjectActivity,
  getSessionActivity,
  getUserById,
  listProjectsForOwner,
  listSessionPlacementsForOwner,
  listSessionIdsForProject,
  listSessionsForOwner,
  listUsers,
} from '../db.ts'
import { errorFields, log } from '../log.ts'
import { bucketFull, bucketStatus, noteUploaded, scanBucket, type BucketStatus } from './bucket-usage.ts'
import { isLive } from './live.ts'
import { isUuid, projectDirFor, sessionDir } from './paths.ts'
import { historyUsage, modelCanvases, type ModelCanvas } from './canvas-history.ts'
import { clearWorkspace, dirUsage } from './workspace-archive.ts'

export interface StorageFile {
  path: string
  sizeBytes: number
  modified: string
}

export interface StorageDir {
  kind: 'chat' | 'project'
  id: string
  title: string | null
  bytes: number
  /** the newest file's */
  modified: string | undefined
  /** visible files other than the model's canvas versions */
  files: StorageFile[]
  /** the model's canvas versions (`canvas-<id>-vN`), one row per canvas (docs/canvas-storage-plan.md) */
  canvases: ModelCanvas[]
  /** the canvas panel's own history in `.canvas/`: snapshots and the user's saved edits */
  canvasHistory: { files: number; bytes: number }
}

interface OwnedDir {
  kind: 'chat' | 'project'
  id: string
  dir: string
}

const visible = (path: string) => !path.split('/').some((part) => part.startsWith('.'))

/**
 * A user's own chat folders and project folders, from the database: a folder that left the disk (its files are on
 * S3 only) is not on the disk to be found. A project chat works in its project's folder, counted once.
 */
async function ownedDirs(userId: number): Promise<OwnedDir[]> {
  const out: OwnedDir[] = []
  for (const { sessionId, projectId } of await listSessionPlacementsForOwner(userId)) {
    if (projectId === undefined && isUuid(sessionId)) out.push({ kind: 'chat', id: sessionId, dir: sessionDir(userId, sessionId) })
  }
  for (const project of await listProjectsForOwner(userId)) {
    const dir = projectDirFor(project.projectId)
    if (dir) out.push({ kind: 'project', id: project.projectId, dir })
  }
  return out
}

/**
 * A user's own quota: USER_FILE_QUOTA_BYTES, or 0 (no limit) for an admin (2026-10-19). Read from the database on
 * every call, so a role change counts at once. The bucket's own limit (bucketFull) still applies to everyone.
 */
async function quotaFor(userId: number): Promise<number> {
  if (config.storage.userQuotaBytes <= 0) return 0
  return (await getUserById(userId))?.role === 'admin' ? 0 : config.storage.userQuotaBytes
}

/** Bytes a user's files take. */
export async function userUsedBytes(userId: number): Promise<number> {
  let bytes = 0
  for (const { dir } of await ownedDirs(userId)) bytes += (await dirUsage(dir)).bytes
  return bytes
}

export interface UserStorage {
  usedBytes: number
  /** 0 = no limit */
  quotaBytes: number
  warnPercent: number
  /** the bucket itself is full: no upload is accepted, whatever the user's own usage */
  bucketFull: boolean
  dirs: StorageDir[]
}

/** What GET /storage answers: usage, quota and every file, the biggest folders first. */
export async function userStorage(userId: number): Promise<UserStorage> {
  const titles = new Map<string, string | null>()
  for (const chat of await listSessionsForOwner(userId)) titles.set(chat.sessionId, chat.title)
  for (const project of await listProjectsForOwner(userId)) titles.set(project.projectId, project.name)
  let usedBytes = 0
  const dirs: StorageDir[] = []
  for (const { kind, id, dir } of await ownedDirs(userId)) {
    const usage = await dirUsage(dir)
    usedBytes += usage.bytes
    const shown = usage.files.filter((f) => visible(f.path))
    const { canvases, versionPaths } = modelCanvases(shown)
    const canvasHistory = historyUsage(usage.files)
    const files = shown
      .filter((f) => !versionPaths.has(f.path))
      .map((f) => ({ path: f.path, sizeBytes: f.size, modified: new Date(f.mtimeMs).toISOString() }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
    if (files.length === 0 && canvases.length === 0 && canvasHistory.files === 0) continue
    const modified = shown.length === 0
      ? undefined
      : new Date(Math.max(...shown.map((f) => f.mtimeMs))).toISOString()
    dirs.push({ kind, id, title: titles.get(id) ?? null, bytes: usage.bytes, modified, files, canvases, canvasHistory })
  }
  dirs.sort((a, b) => b.bytes - a.bytes)
  return {
    usedBytes,
    quotaBytes: await quotaFor(userId),
    warnPercent: config.storage.warnPercent,
    bucketFull: bucketFull(),
    dirs,
  }
}

export type UploadDecision =
  | { ok: true }
  | { ok: false; status: number; code: 'storage_quota' | 'storage_full'; error: string; usedBytes?: number; quotaBytes?: number }

/** Before an upload of `incoming` bytes (its content-length): the bucket's limit, then the user's quota. */
export async function checkUpload(userId: number, incoming: number): Promise<UploadDecision> {
  if (bucketFull(incoming)) {
    return { ok: false, status: 507, code: 'storage_full', error: 'storage is full: delete old files, or ask an admin to free space' }
  }
  // the folder owner's quota: none for an admin
  const quotaBytes = await quotaFor(userId)
  if (quotaBytes <= 0) return { ok: true }
  const usedBytes = await userUsedBytes(userId)
  if (usedBytes + incoming <= quotaBytes) return { ok: true }
  return {
    ok: false,
    status: 507,
    code: 'storage_quota',
    error: `your files take ${usedBytes} of ${quotaBytes} bytes: delete old files to upload more`,
    usedBytes,
    quotaBytes,
  }
}

/** A user deleted files: the bucket estimate goes down now instead of at the next scan. */
export function noteFreed(bytes: number): void {
  noteUploaded(-bytes)
}

export interface AdminStorage {
  bucket: BucketStatus
  quotaBytes: number
  fileRetentionDays: number
  /** quotaBytes: that user's own (0 = no limit: an admin) */
  users: { userId: number; email: string; usedBytes: number; quotaBytes: number }[]
}

/** GET /admin/storage: the bucket and every user's usage, biggest first. */
export async function storageOverview(): Promise<AdminStorage> {
  const users: AdminStorage['users'] = []
  for (const user of await listUsers()) {
    const quotaBytes = user.role === 'admin' ? 0 : config.storage.userQuotaBytes
    users.push({ userId: user.id, email: user.email, usedBytes: await userUsedBytes(user.id), quotaBytes })
  }
  users.sort((a, b) => b.usedBytes - a.usedBytes)
  return { bucket: bucketStatus(), quotaBytes: config.storage.userQuotaBytes, fileRetentionDays: config.storage.fileRetentionDays, users }
}

export interface CleanupResult {
  olderThanDays: number
  dryRun: boolean
  dirs: number
  files: number
  bytes: number
  /** unused that long but a browser has it open right now: left alone */
  skippedLive: number
  /** the first 100 of what was (or, dry run, would be) deleted */
  items: { kind: 'chat' | 'project'; id: string; ownerId: number; bytes: number; lastUsed: string }[]
}

/** Every chat/project folder with its owner (folders of deleted chats are left to their purge). */
async function allDirs(userId?: number): Promise<(OwnedDir & { ownerId: number })[]> {
  const owners = userId !== undefined ? [userId] : (await listUsers()).map((user) => user.id)
  const out: (OwnedDir & { ownerId: number })[] = []
  for (const ownerId of owners) for (const entry of await ownedDirs(ownerId)) out.push({ ...entry, ownerId })
  return out
}

async function inUse(kind: 'chat' | 'project', id: string): Promise<boolean> {
  if (kind === 'chat') return isLive(id)
  return (await listSessionIdsForProject(id)).some(isLive)
}

/**
 * Deletes every file of each chat/project folder whose last use — its newest file, and the chat's last message (a
 * project: its newest chat's) — is older than `olderThanDays`. The chats themselves stay; they just lose their files.
 * `dryRun` only reports. Runs at most one at a time.
 */
let cleaning: Promise<CleanupResult> | undefined
export function cleanupOldFiles(options: { olderThanDays: number; userId?: number; dryRun?: boolean; by: string }): Promise<CleanupResult> {
  if (cleaning) return cleaning
  cleaning = runCleanup(options).finally(() => {
    cleaning = undefined
  })
  return cleaning
}

async function runCleanup({ olderThanDays, userId, dryRun = false, by }: { olderThanDays: number; userId?: number; dryRun?: boolean; by: string }): Promise<CleanupResult> {
  const started = Date.now()
  const cutoff = started - olderThanDays * 86_400_000
  const result: CleanupResult = { olderThanDays, dryRun, dirs: 0, files: 0, bytes: 0, skippedLive: 0, items: [] }
  let failed = 0
  let firstFailure: unknown
  for (const entry of await allDirs(userId)) {
    try {
      const all = (await dirUsage(entry.dir)).files
      // what is deleted: the user's files and the canvas history (`.canvas/`)
      const files = all.filter((f) => visible(f.path) || f.path.startsWith('.canvas/'))
      if (files.length === 0) continue
      // last use from what the user sees only: `.fox/sources.json` is rewritten by every upload, `.dsh/` by every
      // connect, `.canvas/` by opening a file in the panel
      const activity = entry.kind === 'chat' ? await getSessionActivity(entry.id) : await getProjectActivity(entry.id)
      const lastUsed = Math.max(activity?.getTime() ?? 0, ...all.filter((f) => visible(f.path)).map((f) => f.mtimeMs))
      if (lastUsed >= cutoff) continue
      if (await inUse(entry.kind, entry.id)) {
        result.skippedLive += 1
        continue
      }
      const freed = dryRun ? { files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) } : await clearWorkspace(entry.dir)
      result.dirs += 1
      result.files += freed.files
      result.bytes += freed.bytes
      if (result.items.length < 100) {
        result.items.push({ kind: entry.kind, id: entry.id, ownerId: entry.ownerId, bytes: freed.bytes, lastUsed: new Date(lastUsed).toISOString() })
      }
    } catch (error) {
      failed += 1
      firstFailure ??= error
    }
  }
  log('storage_cleanup', {
    by,
    olderThanDays,
    userId,
    dryRun,
    dirs: result.dirs,
    files: result.files,
    bytes: result.bytes,
    skippedLive: result.skippedLive,
    ms: Date.now() - started,
    ...(firstFailure ? { failedDirs: failed, ...errorFields(firstFailure) } : {}),
  }, firstFailure ? 'error' : undefined)
  // the bucket is measured again, so what was freed shows (and unblocks uploads) right away
  if (!dryRun && result.dirs > 0) await scanBucket()
  return result
}

let timer: NodeJS.Timeout | undefined

async function scheduled(): Promise<void> {
  const days = config.storage.fileRetentionDays
  if (days > 0) await cleanupOldFiles({ olderThanDays: days, by: 'schedule' }).catch((error) => log('storage_cleanup', { by: 'schedule', ...errorFields(error) }))
  await scanBucket()
}

/** At start-up: measure the bucket, then again (after the scheduled cleanup, if any) every STORAGE_SCAN_INTERVAL_MS. */
export function startStorageJobs(): void {
  void scheduled()
  timer = setInterval(() => void scheduled(), config.storage.scanIntervalMs)
  timer.unref()
}

export function stopStorageJobs(): void {
  if (timer) clearInterval(timer)
}
