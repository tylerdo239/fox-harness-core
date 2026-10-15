// `custom_skills.content` storage (2026-09-14) — moved off MariaDB onto S3
// (or an S3-compatible service; `config.s3Endpoint` picks which). The DB
// row (services/gateway/src/db.ts) only keeps a stable `content_key`;
// actual skill content round-trips through here. Deliberately a thin,
// direct `@aws-sdk/client-s3` wrapper — NOT a `dsh` Cordis Service
// implementation the way docs/object-storage-strategy.md's
// SessionPersistence/AttachmentStore proposal is; this is a much smaller,
// gateway-only concern with no event-sourcing/torn-tail/content-addressing
// requirements, so a plain client suffices.

import { createWriteStream } from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3'

import { config } from './config.ts'
import { errorFields, log } from './log.ts'

const client = new S3Client({
  region: config.s3Region,
  endpoint: config.s3Endpoint,
  forcePathStyle: config.s3ForcePathStyle,
  credentials: {
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
  },
})

const ENDPOINT = config.s3Endpoint ?? `aws (${config.s3Region})`

// Every S3 call that fails, once (after the SDK's own retries), with what was asked of which bucket and endpoint,
// and a hint for the usual causes. Callers still get the error; many of them only answer "internal error".
// While S3 stays down the archive sweep fails on every file: the same failure is logged once a minute, with how
// many were left out since.
const REPEAT_MS = 60_000
const lastLogged = new Map<string, { at: number; skipped: number }>()

client.middlewareStack.add(
  (next, context) => async (args) => {
    const started = Date.now()
    try {
      return await next(args)
    } catch (error) {
      const input = args.input as { Bucket?: string; Key?: string; Prefix?: string }
      const op = (context.commandName ?? 'S3').replace(/Command$/, '')
      const fields = errorFields(error)
      const key = `${op}|${fields.errorName}|${fields.status}|${fields.errorCode}`
      const last = lastLogged.get(key)
      if (last && started - last.at < REPEAT_MS) {
        last.skipped += 1
        throw error
      }
      lastLogged.set(key, { at: started, skipped: 0 })
      log('s3_failed', {
        op,
        bucket: input.Bucket,
        key: input.Key,
        prefix: input.Prefix,
        endpoint: ENDPOINT,
        ms: Date.now() - started,
        ...fields,
        hint: s3Hint(op, fields),
        repeatedSinceLastLine: last?.skipped || undefined,
        // a missing bucket is created next (a fresh MinIO): only a warning unless that fails too
      }, op === 'HeadBucket' && fields.status === 404 ? 'warn' : undefined)
      throw error
    }
  },
  { step: 'initialize', name: 'foxS3ErrorLog' },
)

function s3Hint(op: string, fields: Record<string, unknown>): string | undefined {
  const name = String(fields.errorName ?? '')
  const code = String(fields.errorCode ?? '')
  const status = fields.status as number | undefined
  if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH)$/.test(code)) {
    return 'cannot reach S3_ENDPOINT: check the URL, DNS, firewall/egress from this pod'
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return "S3_ENDPOINT's TLS certificate is not trusted: internal CA? point NODE_EXTRA_CA_CERTS at its PEM"
  }
  if (name === 'InvalidAccessKeyId') return 'S3_ACCESS_KEY_ID is not known to this S3'
  if (name === 'SignatureDoesNotMatch') return 'S3_SECRET_ACCESS_KEY is wrong, or S3_REGION / S3_FORCE_PATH_STYLE do not match this S3'
  if (name === 'NoSuchBucket' || (op === 'HeadBucket' && status === 404)) return 'bucket S3_BUCKET does not exist on this endpoint; the gateway tries to create it next'
  if (name === 'PermanentRedirect' || status === 301) return 'wrong S3_REGION, or this S3 needs S3_FORCE_PATH_STYLE=true'
  if (status === 403) {
    if (op === 'HeadBucket') return 'denied: the key lacks s3:ListBucket on the bucket (HeadBucket needs it), or the key is wrong'
    if (op === 'CreateBucket') return 'denied creating the bucket: it should already exist, so the HeadBucket before this failed (see that line)'
    return `denied: the key lacks the permission ${op} needs on this bucket`
  }
  return undefined
}

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
  })().catch((error: unknown) => {
    // memoized: every later skill save and session upload fails with this same error, without a new S3 call
    log('s3_bucket_unavailable', {
      bucket: config.s3Bucket,
      endpoint: ENDPOINT,
      ...errorFields(error),
      hint: 'skill saves and session-log uploads fail until the gateway restarts; the s3_failed lines above say why',
    })
    throw error
  })
  return bucketReady
}

/** At start-up: can this process reach the bucket? Logs `s3_check`; never throws (S3 is not needed to chat). */
export async function checkS3(): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.s3Bucket }))
    log('s3_check', { ok: true, bucket: config.s3Bucket, endpoint: ENDPOINT, forcePathStyle: config.s3ForcePathStyle })
  } catch (error) {
    // the s3_failed line has the detail; a missing bucket is created at the first write, if the key may
    const fields = errorFields(error)
    log('s3_check', { ok: false, bucket: config.s3Bucket, endpoint: ENDPOINT, ...fields }, fields.status === 404 ? 'warn' : undefined)
  }
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

/** What the objects under `prefix` ('' = the whole bucket) take: docs/storage-quota-plan.md's bucket scan. */
export async function measureArchivePrefix(prefix: string): Promise<{ bytes: number; objects: number }> {
  let bytes = 0
  let objects = 0
  let token: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: prefix || undefined, ContinuationToken: token }))
    for (const o of page.Contents ?? []) {
      bytes += o.Size ?? 0
      objects += 1
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return { bytes, objects }
}

export async function getArchiveObject(key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }))
  return Buffer.from(await res.Body!.transformToByteArray())
}

/** Downloads an object straight to `path` (via a temporary file next to it), without holding it in memory. */
export async function downloadArchiveObject(key: string, path: string): Promise<void> {
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }))
  const partial = join(dirname(path), `.${basename(path)}.restore`)
  await pipeline(res.Body as Readable, createWriteStream(partial))
  await rename(partial, path)
}

export async function deleteArchiveObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }))
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
