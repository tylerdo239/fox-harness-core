// Roadmap Phase 3 checklist item 4: "Warm pool để che cold start." Only
// covers brand-new sessions — a rehydrate always needs its own specific
// `dshHomeDir`, so a generic pooled container can't stand in for one (see
// services/orchestrator/README.md).

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { config } from './config.ts'
import { spawnWorker } from './docker.ts'
import { materializeDshHome } from './materialize.ts'
import { popWarmPool, pushWarmPool, warmPoolSize, type WarmPoolEntry } from './redis.ts'

async function spawnPoolMember(): Promise<WarmPoolEntry> {
  const dshHomeDir = join(config.dataDir, '_pool', randomUUID())
  await materializeDshHome(dshHomeDir)
  // Phase 12 item 4: a pool member is always the documented DEFAULT model
  // (allowedModels[0]) — explicit, not "whatever the orchestrator process's
  // raw OPENAI_MODEL_ID happens to be" (those two can diverge once an
  // operator configures OPENAI_ALLOWED_MODELS as a real list). ensure.ts
  // only ever claims a pool member for a request that named no model at all,
  // so this is the one value such a request should get.
  const worker = await spawnWorker(dshHomeDir, undefined, config.allowedModels[0])
  return { ...worker, dshHomeDir }
}

/**
 * Top the pool up to `config.warmPoolSize`. Safe to call repeatedly/concurrently — over-filling by a member or two under a race is harmless.
 * Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
 * finding #7): spawns the whole deficit in parallel instead of one at a
 * time — each `waitUntilReachable` readiness check alone can take up to
 * 15s, so a sequential `for` made replenishing a pool of size N take up to
 * N × 15s. `allSettled`, not `all`: one bad spawn logs and is skipped,
 * it no longer aborts the rest of the batch the way the old `break` did.
 */
export async function replenishWarmPool(): Promise<void> {
  const size = await warmPoolSize()
  const deficit = config.warmPoolSize - size
  if (deficit <= 0) return
  const results = await Promise.allSettled(
    Array.from({ length: deficit }, async () => {
      const entry = await spawnPoolMember()
      await pushWarmPool(entry)
    }),
  )
  for (const result of results) {
    if (result.status === 'rejected') console.error('[orchestrator] warm pool replenish failed:', result.reason)
  }
}

/** Claim one pre-started container for a brand-new session, or `undefined` if the pool is empty (caller falls back to a cold spawn). */
export async function claimWarmPoolMember(): Promise<WarmPoolEntry | undefined> {
  const entry = await popWarmPool()
  if (entry) void replenishWarmPool() // fire-and-forget — don't make the caller wait on it
  return entry
}
