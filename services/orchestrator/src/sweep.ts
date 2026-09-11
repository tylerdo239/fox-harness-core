// Idle-TTL hibernate (roadmap Phase 3 checklist item 3, hibernate half —
// rehydrate lives in ensure.ts, triggered on next access rather than by this
// sweep). Deliberate scope cut, not yet done: this does not check whether the
// agent is mid-turn (`Agent.status`/`whenIdle()`) before hibernating — it
// only knows "no gateway activity for this long" (redis.ts's `lastActive`,
// touched on connect/disconnect). A session generating a long reply with no
// browser attached can be hibernated mid-turn by this sweep today. Does not
// block the Phase 3 completion test (data integrity after kill -9), which is
// exactly what a mid-turn hibernate also exercises — but is a real product
// gap before this ships for real users. See services/orchestrator/README.md.

import { archiveSession } from './archive.ts'
import { config } from './config.ts'
import { removeWorker } from './docker.ts'
import { getLastActive, getSession, listHibernatedSessionIds, listRunningSessionIds, setSession, type SessionRecord } from './redis.ts'

// Same structured-log convention as index.ts (docs/code-rules.md's
// "mirrored, not imported" — see that file's own comment for why this
// isn't a shared import).
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'orchestrator', event, ...fields }))
}

async function hibernate(id: string, record: SessionRecord, now: number): Promise<void> {
  await removeWorker(record.containerId)
  await setSession(id, { ...record, status: 'hibernated', hibernatedAt: now })
}

async function sweepRunning(now: number): Promise<void> {
  const ids = await listRunningSessionIds()
  for (const id of ids) {
    const record = await getSession(id)
    if (!record || record.status !== 'running') continue

    // Phase 6 checklist item 1: runtime quota — total session age, checked
    // BEFORE the idle check below so a session generating constant traffic
    // can't dodge it just by staying active (idle TTL alone never catches
    // that case).
    if (config.maxSessionAgeMs > 0 && now - record.createdAt > config.maxSessionAgeMs) {
      log('hibernate_max_age', { sessionId: id, containerId: record.containerId })
      await hibernate(id, record, now)
      continue
    }

    const lastActive = await getLastActive(id)
    if (lastActive === undefined || now - lastActive < config.idleTtlMs) continue

    log('hibernate_idle', { sessionId: id, containerId: record.containerId })
    await hibernate(id, record, now)
  }
}

// Phase 6 checklist item 4: log retention. A session hibernated longer than
// ARCHIVE_AFTER_HIBERNATED_MS gets compressed off live disk (archive.ts) —
// disabled entirely (config default 0) so a dev setup that never configured
// this keeps every hibernated session instantly rehydratable, matching
// every prior phase's behavior.
async function sweepArchival(now: number): Promise<void> {
  if (config.archiveAfterHibernatedMs <= 0) return
  const ids = await listHibernatedSessionIds()
  for (const id of ids) {
    const record = await getSession(id)
    if (!record || record.status !== 'hibernated' || record.hibernatedAt === undefined) continue
    if (now - record.hibernatedAt < config.archiveAfterHibernatedMs) continue

    log('archive_start', { sessionId: id })
    try {
      await archiveSession(record.dshHomeDir, config.archiveDir, id)
      await setSession(id, { ...record, status: 'archived' })
      log('archive_ok', { sessionId: id })
    } catch (error) {
      console.error(`[orchestrator] archive(${id}) failed:`, error)
      log('archive_failed', { sessionId: id, error: String(error) })
    }
  }
}

async function sweepOnce(): Promise<void> {
  const now = Date.now()
  await sweepRunning(now)
  await sweepArchival(now)
}

export function startIdleSweep(): () => void {
  const interval = setInterval(() => {
    sweepOnce().catch((error: unknown) => {
      console.error('[orchestrator] idle sweep failed:', error)
    })
  }, config.sweepIntervalMs)
  return () => clearInterval(interval)
}
