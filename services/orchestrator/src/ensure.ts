// The one operation services/gateway calls per connection (new or
// reconnecting): guarantee a live worker for `sessionId` and return where to
// reach it. Ties together Redis affinity/lock (roadmap Phase 3 item 1),
// container spawn (item 2), rehydrate (item 3), and warm pool (item 4).

import { join } from 'node:path'

import type { EnsureSessionResponse } from '@fox-harness/contracts'

import { restoreSession } from './archive.ts'
import { config } from './config.ts'
import { isRunning, spawnWorker } from './docker.ts'
import { InvalidFlowError, InvalidModelError, QuotaExceededError } from './errors.ts'
import { materializeDshHome } from './materialize.ts'
import { acquireSpawnLock, getSession, listRunningSessionIds, setSession, touch, type SessionRecord } from './redis.ts'
import { claimWarmPoolMember } from './warmpool.ts'

async function waitForLockHolder(sessionId: string): Promise<EnsureSessionResponse> {
  // Another request is already spawning this exact session (the roadmap's
  // "lock lúc spawn") — poll for the record it's about to publish instead of
  // racing a second container into existence. Bounded by the lock's own TTL
  // plus slack: a holder that dies mid-spawn releases nothing, but the lock
  // expires on its own (config.spawnLockTtlMs) and a later caller retries.
  const deadline = Date.now() + config.spawnLockTtlMs + 5000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const record = await getSession(sessionId)
    if (record && record.status === 'running' && (await isRunning(record.containerId))) {
      return { host: record.host, port: record.port }
    }
  }
  throw new Error(`fox-harness-orchestrator: timed out waiting for concurrent spawn of session ${sessionId}`)
}

export async function ensureSession(sessionId: string, model?: string, flow?: string): Promise<EnsureSessionResponse> {
  // Phase 12 item 4: validated here, once, for the only path that can ever
  // set it (a brand-new session, below) — a reconnect/rehydrate ignores this
  // parameter entirely and reuses whatever the session already carries.
  if (model !== undefined && !config.allowedModels.includes(model)) {
    throw new InvalidModelError(`model '${model}' is not in the configured allow-list`)
  }
  // docs/data-analysis-flow-plan.md: same rule as `model` above, for which
  // agent loop/profile a brand-new session spawns with.
  if (flow !== undefined && !config.allowedFlows.includes(flow)) {
    throw new InvalidFlowError(`flow '${flow}' is not in the configured allow-list`)
  }

  const release = await acquireSpawnLock(sessionId)
  if (!release) return waitForLockHolder(sessionId)

  try {
    const existing = await getSession(sessionId)
    if (existing?.status === 'running' && (await isRunning(existing.containerId))) {
      await touch(sessionId)
      return { host: existing.host, port: existing.port }
    }

    if (existing) {
      // Phase 6 checklist item 4: a session archived by the retention sweep
      // (services/orchestrator/src/sweep.ts) has no live dshHomeDir left —
      // restore it from `config.archiveDir` before a container can bind-mount
      // it again. No-op cost for the (default, unconfigured) common case:
      // status is never 'archived' unless ARCHIVE_AFTER_HIBERNATED_MS > 0.
      if (existing.status === 'archived') {
        await restoreSession(existing.dshHomeDir, config.archiveDir, sessionId)
      }
      // Hibernated, or its container died unexpectedly (idle-TTL sweep vs. a
      // `kill -9` both land here identically) — rehydrate: same directory,
      // brand-new container. Never restart the old one (see README). Reuses
      // `existing.model`/`existing.flow` (Phase 12 / docs/data-analysis-flow-plan.md)
      // — a rehydrate must spawn with the SAME model/flow chosen at
      // creation, never today's caller-supplied values.
      const existingFlow = existing.flow ?? 'default'
      const profileName = config.flows[existingFlow as keyof typeof config.flows]?.profileName ?? config.flows.default.profileName
      const worker = await spawnWorker(existing.dshHomeDir, sessionId, existing.model, profileName)
      const record: SessionRecord = {
        ...worker,
        dshHomeDir: existing.dshHomeDir,
        status: 'running',
        createdAt: existing.createdAt,
        ...(existing.model !== undefined ? { model: existing.model } : {}),
        ...(existing.flow !== undefined ? { flow: existing.flow } : {}),
      }
      await setSession(sessionId, record)
      await touch(sessionId)
      return { host: worker.host, port: worker.port }
    }

    // Phase 6 checklist item 1: concurrent-session quota. Checked only for a
    // genuinely NEW session — an existing session reconnecting/rehydrating
    // above is never turned away by this (a cap that could evict a session
    // mid-conversation would violate roadmap §0.4's "state must survive").
    // Global, not per-user: this project has no real user identity (see
    // config.ts's own comment). Racy under concurrent brand-new requests by
    // design, same "safe to overshoot by a little under a race" tradeoff as
    // warmpool.ts's replenish — an exact global atomic counter isn't worth
    // the added coordination for a soft capacity guard.
    if (config.maxConcurrentSessions > 0) {
      const runningCount = (await listRunningSessionIds()).length
      if (runningCount >= config.maxConcurrentSessions) {
        throw new QuotaExceededError(`max concurrent sessions reached (${config.maxConcurrentSessions})`)
      }
    }

    const createdAt = Date.now()

    // Brand new session (gateway pre-assigned this id — see
    // services/gateway/README.md). Prefer a warm pool member to hide cold
    // start — but only for the default model AND the default flow: pool
    // members are always spawned with `config.allowedModels[0]` and the
    // `default` flow specifically (warmpool.ts), so a request naming a
    // different model or a non-default flow skips the pool and cold-spawns
    // instead of silently ignoring what it asked for.
    if (model === undefined && flow === undefined) {
      const claimed = await claimWarmPoolMember()
      if (claimed) {
        const record: SessionRecord = { ...claimed, status: 'running', createdAt, model: config.allowedModels[0], flow: 'default' }
        await setSession(sessionId, record)
        await touch(sessionId)
        return { host: claimed.host, port: claimed.port }
      }
    }

    const resolvedModel = model ?? config.allowedModels[0]
    const resolvedFlow = flow ?? 'default'
    const profileName = config.flows[resolvedFlow as keyof typeof config.flows].profileName
    const dshHomeDir = join(config.dataDir, sessionId)
    await materializeDshHome(dshHomeDir, resolvedFlow)
    const worker = await spawnWorker(dshHomeDir, sessionId, resolvedModel, profileName)
    const record: SessionRecord = { ...worker, dshHomeDir, status: 'running', createdAt, model: resolvedModel, flow: resolvedFlow }
    await setSession(sessionId, record)
    await touch(sessionId)
    return { host: worker.host, port: worker.port }
  } finally {
    await release()
  }
}
