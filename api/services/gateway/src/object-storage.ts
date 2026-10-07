// `custom_skills.content` storage (2026-09-14) — moved off MariaDB onto S3
// (or an S3-compatible service; `config.s3Endpoint` picks which). The DB
// row (services/gateway/src/db.ts) only keeps a stable `content_key`;
// actual skill content round-trips through here. Deliberately a thin,
// direct `@aws-sdk/client-s3` wrapper — NOT a `dsh` Cordis Service
// implementation the way docs/object-storage-strategy.md's
// SessionPersistence/AttachmentStore proposal is; this is a much smaller,
// gateway-only concern with no event-sourcing/torn-tail/content-addressing
// requirements, so a plain client suffices.

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  type LifecycleRule,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3'

import { config } from './config.ts'

const client = new S3Client({
  region: config.s3Region,
  endpoint: config.s3Endpoint,
  forcePathStyle: config.s3ForcePathStyle,
  credentials: {
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
  },
})

// Idempotent, safe against a real AWS bucket too (HeadBucket just succeeds
// immediately there — this only ever actually creates anything against a
// fresh MinIO instance that has no buckets yet). Memoized so a busy process
// doesn't re-check on every single put.
let bucketReady: Promise<void> | undefined
function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.s3Bucket }))
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: config.s3Bucket }))
    }
  })()
  return bucketReady
}

export function skillContentKey(ownerId: number, name: string): string {
  return `custom-skills/${ownerId}/${name}`
}

export async function putSkillContent(key: string, content: string): Promise<void> {
  await ensureBucket()
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: content,
      ContentType: 'text/markdown; charset=utf-8',
    }),
  )
}

export async function getSkillContent(key: string): Promise<string> {
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }))
  // AWS SDK v3's response body is a web/Node stream depending on runtime;
  // `transformToString` is the SDK-provided helper that handles either.
  return res.Body!.transformToString('utf-8')
}

// Best-effort — an orphaned object nobody ever reads again is harmless,
// unlike an orphaned DB row pointing at a missing object (see db.ts's
// write-ordering comments for the full reasoning).
export async function deleteSkillContent(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }))
}

// ---- session archive (docs/session-archive-plan.md) ----

export async function putArchiveObject(key: string, body: Buffer): Promise<void> {
  await ensureBucket()
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream',
      ...(config.s3Sse ? { ServerSideEncryption: config.s3Sse as ServerSideEncryption } : {}),
    }),
  )
}

export async function listArchiveKeys(prefix: string): Promise<string[]> {
  await ensureBucket()
  const keys: string[] = []
  let token: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: prefix, ContinuationToken: token }))
    for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key)
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return keys
}

export async function getArchiveObject(key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }))
  return Buffer.from(await res.Body!.transformToByteArray())
}

/** Right to erasure: every object AND every version (and delete marker) under the prefix. */
export async function deleteArchivePrefix(prefix: string): Promise<number> {
  await ensureBucket()
  let deleted = 0
  let keyMarker: string | undefined
  let versionMarker: string | undefined
  for (;;) {
    const page = await client.send(
      new ListObjectVersionsCommand({ Bucket: config.s3Bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
    )
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((v) => v.Key)
      .map((v) => ({ Key: v.Key!, ...(v.VersionId && v.VersionId !== 'null' ? { VersionId: v.VersionId } : {}) }))
    if (objects.length > 0) {
      await client.send(new DeleteObjectsCommand({ Bucket: config.s3Bucket, Delete: { Objects: objects, Quiet: true } }))
      deleted += objects.length
    }
    if (!page.IsTruncated) break
    keyMarker = page.NextKeyMarker
    versionMarker = page.NextVersionIdMarker
  }
  return deleted
}

const RETENTION_RULE_ID = 'fox-session-retention'

/** Adds (never replaces other rules) the lifecycle rule that deletes session archives `days` after their last write. */
export async function ensureArchiveRetention(prefix: string, days: number): Promise<'added' | 'present'> {
  await ensureBucket()
  let rules: LifecycleRule[] = []
  try {
    rules = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: config.s3Bucket }))).Rules ?? []
  } catch (error) {
    // no configuration yet
    if ((error as { name?: string }).name !== 'NoSuchLifecycleConfiguration') throw error
  }
  const existing = rules.find((r) => r.ID === RETENTION_RULE_ID)
  if (existing && existing.Expiration?.Days === days && existing.Filter?.Prefix === prefix) return 'present'
  const rule: LifecycleRule = {
    ID: RETENTION_RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: prefix },
    Expiration: { Days: days },
    // with versioning on, an overwritten or deleted archive must not linger as an old version
    NoncurrentVersionExpiration: { NoncurrentDays: 1 },
  }
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: config.s3Bucket,
      LifecycleConfiguration: { Rules: [...rules.filter((r) => r.ID !== RETENTION_RULE_ID), rule] },
    }),
  )
  return 'added'
}
