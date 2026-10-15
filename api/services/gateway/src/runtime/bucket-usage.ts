// docs/storage-quota-plan.md — how full the bucket is. It has a fixed size (S3_BUCKET_CAPACITY_BYTES) and no
// lifecycle rule, so the gateway measures it (one listing of every object, every STORAGE_SCAN_INTERVAL_MS) and
// refuses uploads once it reaches STORAGE_BLOCK_PERCENT. Between two scans what the archive sweep uploaded is added
// to the last measure (an overwrite counts again: an estimate on the safe side until the next scan).
import { config } from '../config.ts'
import { errorFields, log } from '../log.ts'
import { measureArchivePrefix } from '../object-storage.ts'

interface Measure {
  bytes: number
  objects: number
  at: number
}

let measured: Measure | undefined
let uploadedSince = 0

export const capacityBytes = (): number => config.storage.bucketCapacityBytes
const measuring = (): boolean => config.sessionArchive.enabled && capacityBytes() > 0

/** Called by the archive sweep with what it just uploaded. */
export function noteUploaded(bytes: number): void {
  uploadedSince += bytes
}

export interface BucketStatus {
  capacityBytes: number
  /** the last scan plus what was uploaded since; undefined before the first scan succeeded */
  usedBytes: number | undefined
  objects: number | undefined
  scannedAt: string | undefined
  percent: number | undefined
  warnPercent: number
  blockPercent: number
}

export function bucketStatus(): BucketStatus {
  const used = measured ? measured.bytes + uploadedSince : undefined
  return {
    capacityBytes: capacityBytes(),
    usedBytes: used,
    objects: measured?.objects,
    scannedAt: measured ? new Date(measured.at).toISOString() : undefined,
    percent: used !== undefined && capacityBytes() > 0 ? Math.round((used / capacityBytes()) * 1000) / 10 : undefined,
    warnPercent: config.storage.warnPercent,
    blockPercent: config.storage.blockPercent,
  }
}

/** Would `incoming` more bytes take the bucket past STORAGE_BLOCK_PERCENT? False while it is not measured. */
export function bucketFull(incoming = 0): boolean {
  if (!measuring() || !measured) return false
  return measured.bytes + uploadedSince + incoming > (capacityBytes() * config.storage.blockPercent) / 100
}

/** One listing of the whole bucket. Logs `storage_usage` (warn from STORAGE_WARN_PERCENT, error from the block). */
export async function scanBucket(): Promise<void> {
  if (!measuring()) return
  const started = Date.now()
  try {
    const { bytes, objects } = await measureArchivePrefix('')
    measured = { bytes, objects, at: started }
    uploadedSince = 0
  } catch (error) {
    // a fresh MinIO: the bucket is created at the first write, empty until then
    if (errorFields(error).errorName === 'NoSuchBucket') {
      measured = { bytes: 0, objects: 0, at: started }
      uploadedSince = 0
      return
    }
    // the s3_failed line above says why (a listing needs s3:ListBucket); uploads are not blocked meanwhile
    log('storage_scan_failed', { ...errorFields(error), hint: 'bucket usage unknown: uploads are not limited by it until a scan succeeds' })
    return
  }
  const status = bucketStatus()
  const percent = status.percent ?? 0
  const level = percent >= config.storage.blockPercent ? 'error' : percent >= config.storage.warnPercent ? 'warn' : 'info'
  log('storage_usage', {
    bucketBytes: measured.bytes,
    objects: measured.objects,
    capacityBytes: capacityBytes(),
    percent,
    ms: Date.now() - started,
    ...(level === 'error'
      ? { hint: `uploads are refused from ${config.storage.blockPercent}%: delete old files (admin: POST /admin/storage/cleanup)` }
      : level === 'warn'
        ? { hint: `over ${config.storage.warnPercent}%: uploads stop at ${config.storage.blockPercent}%` }
        : {}),
  }, level)
}
