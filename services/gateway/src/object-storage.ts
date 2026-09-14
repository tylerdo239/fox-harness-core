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
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
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
