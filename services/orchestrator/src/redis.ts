// Redis affinity + spawn lock (roadmap Phase 3 item 1: "Redis affinity
// sessionId -> node, lock lúc spawn"). "node" here is one Docker container on
// this single dev-machine Docker daemon — see infra/docker/worker/README for
// the multi-node caveat. Plain key/value + one list; no Redis-specific
// cleverness needed at this scale.

import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'

import { config } from './config.ts'

export interface SessionRecord {
  containerId: string
  host: string
  port: number
  // Absolute host path — the same directory this session's container had
  // (or will have again on rehydrate) bind-mounted as $DSH_HOME. This is the
  // one thing that must survive a container's death for rehydrate to work.
  // Still meaningful for an 'archived' record: it's where `archive.ts`
  // restores TO, not necessarily where anything lives right now.
  dshHomeDir: string
  // 'archived' (Phase 6): dshHomeDir has been compressed into
  // config.archiveDir and removed from live disk — see archive.ts. A record
  // in this state must be restored before it can spawn a worker again.
  status: 'running' | 'hibernated' | 'archived'
  // Phase 6 checklist item 1: set once, at real creation, and carried
  // through every rehydrate/hibernate/archive transition unchanged — this
  // is total session lifetime, not "time since last spawn", so a session
  // can't dodge the max-age quota by being repeatedly killed and rehydrated.
  createdAt: number
  // Phase 6 checklist item 4: set when a session transitions to
  // 'hibernated' (sweep.ts) — the archival sweep's own clock, separate from
  // idleTtlMs's `lastActive`.
  hibernatedAt?: number
  // Phase 12 item 4: the model this session's container was spawned with,
  // chosen once at creation from config.allowedModels and carried unchanged
  // through every rehydrate (ensure.ts) — this record IS the operational
  // source of truth for "which model", not the database (which never stores it;
  // see services/gateway/src/db.ts). Absent for a session created before
  // Phase 12, or the pool-spawn path (warmpool.ts) — spawnWorker() falls
  // back to the orchestrator's own OPENAI_MODEL_ID env value when undefined.
  model?: string
  // docs/data-analysis-flow-plan.md: which agent loop/profile this session's
  // container was spawned with, chosen once at creation from
  // config.allowedFlows and carried unchanged through every rehydrate
  // (ensure.ts) — same rule as `model` above. Absent for a session created
  // before this field existed, or the pool-spawn path (warmpool.ts) — both
  // mean the `default` flow.
  flow?: string
}

export interface WarmPoolEntry {
  containerId: string
  host: string
  port: number
  dshHomeDir: string
}

const redis = new Redis(config.redisUrl)

const sessionKey = (id: string) => `fh:session:${id}`
const lastActiveKey = (id: string) => `fh:session:${id}:lastActive`
const spawnLockKey = (id: string) => `fh:lock:spawn:${id}`
const WARM_POOL_KEY = 'fh:warmpool'

// Performance fix 2026-09-09: docs/security-performance-review-2026-09-09.md
// finding #1 — `listSessionIdsByStatus` used to `KEYS fh:session:*` then
// GET every single one to filter by status, an O(n) full-keyspace scan
// that blocks Redis (single-threaded), run every sweep tick AND every
// concurrent-session-quota check. These 3 sets track membership instead,
// kept in sync by `setSession`/`deleteSession` below (the ONLY 2 functions
// that ever write a SessionRecord's status) — listing becomes a plain
// O(1) `SMEMBERS`.
const ALL_STATUSES: SessionRecord['status'][] = ['running', 'hibernated', 'archived']
const statusSetKey = (status: SessionRecord['status']) => `fh:session:status:${status}`

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  const raw = await redis.get(sessionKey(id))
  return raw ? (JSON.parse(raw) as SessionRecord) : undefined
}

export async function setSession(id: string, record: SessionRecord): Promise<void> {
  // `SREM` from every status set unconditionally (fixed cost, 3 commands)
  // rather than reading the old record first to know which one to remove
  // from — cheaper than a read-before-write, and idempotent (removing an
  // id from a set it isn't in is a harmless no-op).
  const pipeline = redis.pipeline()
  pipeline.set(sessionKey(id), JSON.stringify(record))
  for (const status of ALL_STATUSES) pipeline.srem(statusSetKey(status), id)
  pipeline.sadd(statusSetKey(record.status), id)
  await pipeline.exec()
}

/** Phase 6 checklist item 4: real delete-on-request — drops the affinity record entirely (index.ts's purge route pairs this with actually deleting the on-disk directory/archive via archive.ts's `purgeSession`). */
export async function deleteSession(id: string): Promise<void> {
  const pipeline = redis.pipeline()
  pipeline.del(sessionKey(id), lastActiveKey(id))
  for (const status of ALL_STATUSES) pipeline.srem(statusSetKey(status), id)
  await pipeline.exec()
}

export async function touch(id: string): Promise<void> {
  await redis.set(lastActiveKey(id), Date.now())
}

export async function getLastActive(id: string): Promise<number | undefined> {
  const raw = await redis.get(lastActiveKey(id))
  return raw ? Number(raw) : undefined
}

/** All sessionIds currently marked `running` — the idle sweep's candidate set, and the concurrent-session quota's count. */
export async function listRunningSessionIds(): Promise<string[]> {
  return redis.smembers(statusSetKey('running'))
}

/** All sessionIds currently marked `hibernated` — the archival sweep's candidate set (Phase 6). */
export async function listHibernatedSessionIds(): Promise<string[]> {
  return redis.smembers(statusSetKey('hibernated'))
}

/**
 * `SET NX PX` spawn lock, returning a release function on success or
 * `undefined` if another request already holds it. Token-guarded release so
 * a slow holder can never delete a lock a later holder already re-acquired
 * after this one's TTL expired.
 */
export async function acquireSpawnLock(id: string): Promise<(() => Promise<void>) | undefined> {
  const token = randomUUID()
  const acquired = await redis.set(spawnLockKey(id), token, 'PX', config.spawnLockTtlMs, 'NX')
  if (acquired !== 'OK') return undefined
  return async () => {
    const current = await redis.get(spawnLockKey(id))
    if (current === token) await redis.del(spawnLockKey(id))
  }
}

export async function pushWarmPool(entry: WarmPoolEntry): Promise<void> {
  await redis.rpush(WARM_POOL_KEY, JSON.stringify(entry))
}

export async function popWarmPool(): Promise<WarmPoolEntry | undefined> {
  const raw = await redis.lpop(WARM_POOL_KEY)
  return raw ? (JSON.parse(raw) as WarmPoolEntry) : undefined
}

export async function warmPoolSize(): Promise<number> {
  return redis.llen(WARM_POOL_KEY)
}
