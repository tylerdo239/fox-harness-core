// Which sessions currently have a browser connected, and whose they are. The orchestrator's Redis record
// answered this ("running"); here it is plain memory of this process, which is exactly right: a connection IS
// a WebSocket this process holds. Also where the concurrent-session quota is enforced.

import { config } from '../config.ts'

const connections = new Map<string, { userId: number; count: number }>()

export type QuotaDecision = { ok: true } | { ok: false; reason: 'global' | 'per-user' }

/** Admit a connection to `sessionId`? Only a session that is not already live adds to the totals. */
export function checkQuota(sessionId: string, userId: number): QuotaDecision {
  if (connections.has(sessionId)) return { ok: true }
  if (config.maxConcurrentSessions > 0 && connections.size >= config.maxConcurrentSessions) return { ok: false, reason: 'global' }
  if (config.maxSessionsPerUser > 0) {
    let own = 0
    for (const entry of connections.values()) if (entry.userId === userId) own += 1
    if (own >= config.maxSessionsPerUser) return { ok: false, reason: 'per-user' }
  }
  return { ok: true }
}

/** Register a connection; returns the function that unregisters it. */
export function track(sessionId: string, userId: number): () => void {
  const entry = connections.get(sessionId) ?? { userId, count: 0 }
  entry.count += 1
  connections.set(sessionId, entry)
  let released = false
  return () => {
    if (released) return
    released = true
    entry.count -= 1
    if (entry.count <= 0 && connections.get(sessionId) === entry) connections.delete(sessionId)
  }
}

export const isLive = (sessionId: string): boolean => connections.has(sessionId)
export const liveCount = (): number => connections.size
