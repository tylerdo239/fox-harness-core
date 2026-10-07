// docs/session-archive-plan.md — dsh session logs copied to S3 (`sessions/<owner>/<session>/<dsh dir>/<file>`).
// The local disk stays dsh's working copy; S3 is the archive: a sweep uploads what changed, a log untouched for
// SESSION_LOCAL_RETENTION_DAYS (and archived) leaves the disk, reopening such a chat downloads it first, and a
// purge deletes every copy. Retention (12 months) is a lifecycle rule on the bucket's `sessions/` prefix.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { config } from '../config.ts'
import { getSessionOwnerId } from '../db.ts'
import { deleteArchivePrefix, ensureArchiveRetention, getArchiveObject, listArchiveKeys, putArchiveObject } from '../object-storage.ts'
import { archivedStamp, forgetArchived, setArchivedStamp } from '../redis.ts'
import { dshHome } from './paths.ts'

const PREFIX = 'sessions/'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// a file still being written is left for the next sweep
const SETTLE_MS = 5_000

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'gateway', event, ...fields }))

const root = () => join(dshHome(), 'sessions')
const keyPrefix = (ownerId: number, sessionId: string) => `${PREFIX}${ownerId}/${sessionId}/`

interface LogFile {
  bucket: string // dsh's per-working-directory folder
  sessionId: string
  name: string
  path: string
  mtimeMs: number
  size: number
}

async function sessionFiles(): Promise<LogFile[]> {
  const out: LogFile[] = []
  for (const bucket of await readdir(root()).catch(() => [] as string[])) {
    for (const sessionId of await readdir(join(root(), bucket)).catch(() => [] as string[])) {
      if (!UUID.test(sessionId)) continue
      const dir = join(root(), bucket, sessionId)
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const info = await stat(join(dir, name)).catch(() => undefined)
        if (info?.isFile()) out.push({ bucket, sessionId, name, path: join(dir, name), mtimeMs: info.mtimeMs, size: info.size })
      }
    }
  }
  return out
}

const stampOf = (f: LogFile) => `${Math.floor(f.mtimeMs)}:${f.size}`
const fieldOf = (f: LogFile) => `${f.bucket}/${f.sessionId}/${f.name}`

let sweeping: Promise<void> | undefined

/** One pass: upload changed logs, then drop old archived ones from the disk. */
export function sweep(): Promise<void> {
  sweeping ??= (async () => {
    const owners = new Map<string, number | undefined>()
    const ownerOf = async (sessionId: string) => {
      if (!owners.has(sessionId)) owners.set(sessionId, await getSessionOwnerId(sessionId))
      return owners.get(sessionId)
    }
    let uploaded = 0
    let evicted = 0
    const now = Date.now()
    const evictable = new Map<string, boolean>() // `${bucket}/${sessionId}` → every file archived and old
    for (const f of await sessionFiles()) {
      const owner = await ownerOf(f.sessionId)
      if (owner === undefined) continue // not a user's chat (readiness probe) or already deleted
      const dirKey = `${f.bucket}/${f.sessionId}`
      const current = (await archivedStamp(fieldOf(f))) === stampOf(f)
      if (!current && now - f.mtimeMs >= SETTLE_MS) {
        try {
          await putArchiveObject(`${keyPrefix(owner, f.sessionId)}${f.bucket}/${f.name}`, await readFile(f.path))
          await setArchivedStamp(fieldOf(f), stampOf(f))
          uploaded += 1
        } catch (error) {
          log('session_archive_failed', { sessionId: f.sessionId, error: String(error) })
          evictable.set(dirKey, false)
          continue
        }
      }
      const archived = current || (await archivedStamp(fieldOf(f))) === stampOf(f)
      const old = config.sessionArchive.localRetentionDays > 0 && now - f.mtimeMs > config.sessionArchive.localRetentionDays * 86_400_000
      evictable.set(dirKey, (evictable.get(dirKey) ?? true) && archived && old)
    }
    for (const [dirKey, ok] of evictable) {
      if (!ok) continue
      await rm(join(root(), dirKey), { recursive: true, force: true })
      evicted += 1
    }
    if (uploaded > 0 || evicted > 0) log('session_archive', { uploaded, evictedFromDisk: evicted })
  })().finally(() => {
    sweeping = undefined
  })
  return sweeping
}

/** Before a chat is reopened: if its log is no longer on the disk, bring it back from S3. */
export async function ensureLocal(sessionId: string, ownerId: number): Promise<void> {
  if (!config.sessionArchive.enabled || !UUID.test(sessionId)) return
  for (const bucket of await readdir(root()).catch(() => [] as string[])) {
    if ((await stat(join(root(), bucket, sessionId)).catch(() => undefined))?.isDirectory()) return
  }
  const prefix = keyPrefix(ownerId, sessionId)
  const keys = await listArchiveKeys(prefix)
  for (const key of keys) {
    const [bucket, name, ...rest] = key.slice(prefix.length).split('/')
    // only the shape this module writes; a key that would leave the sessions folder is ignored
    if (!bucket || !name || rest.length > 0 || bucket.includes('..') || name.includes('..')) continue
    const dir = join(root(), bucket, sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), await getArchiveObject(key))
    const info = await stat(join(dir, name))
    await setArchivedStamp(`${bucket}/${sessionId}/${name}`, `${Math.floor(info.mtimeMs)}:${info.size}`)
  }
  if (keys.length > 0) log('session_restored', { sessionId, files: keys.length })
}

/** Right to erasure: every archived copy of the chat. */
export async function deleteArchived(sessionId: string, ownerId: number): Promise<void> {
  if (!config.sessionArchive.enabled || !UUID.test(sessionId)) return
  await deleteArchivePrefix(keyPrefix(ownerId, sessionId))
  await forgetArchived(sessionId)
}

let timer: NodeJS.Timeout | undefined

export async function startArchiver(): Promise<void> {
  if (!config.sessionArchive.enabled) return
  if (config.sessionArchive.retentionDays > 0) {
    try {
      const result = await ensureArchiveRetention(PREFIX, config.sessionArchive.retentionDays)
      log('session_archive_retention', { result, days: config.sessionArchive.retentionDays })
    } catch (error) {
      log('session_archive_retention_failed', {
        error: String(error),
        warning: `set a lifecycle rule on the bucket's "${PREFIX}" prefix by hand (expire after ${config.sessionArchive.retentionDays} days)`,
      })
    }
  }
  timer = setInterval(() => void sweep().catch((error) => log('session_archive_failed', { error: String(error) })), config.sessionArchive.intervalMs)
  timer.unref()
}

/** On shutdown: one last pass so the latest turns are archived. */
export async function stopArchiver(): Promise<void> {
  if (timer) clearInterval(timer)
  if (config.sessionArchive.enabled) await sweep().catch((error) => log('session_archive_failed', { error: String(error) }))
}
