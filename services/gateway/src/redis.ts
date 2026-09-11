// Phase 7: real login-token store (`fh:gwtoken:*`), Redis-backed specifically
// so an admin can revoke a token instantly (docs/agent-core-architecture-roadmap.md's
// Phase 7 architecture decision — chosen over a stateless JWT for exactly
// this reason) — reuses the same Redis this repo has run since Phase 3
// (services/orchestrator/src/redis.ts), a separate `ioredis` client here
// since services/* don't import each other (docs/code-rules.md §1).
//
// Phase 12 item 2 ADDS read-only access to orchestrator's OWN `fh:session:*`
// affinity records (a different key namespace, same Redis instance) — used
// only to attach a live status dot to GET /sessions/mine's listing. This is
// the same "Redis is a store SHARED across services, not orchestrator-
// private" precedent Phase 5 already established (services/plugin-registry
// reads it directly too, see that service's README), not a new exception.

import { Redis } from 'ioredis'

import { config } from './config.ts'
import type { Role } from './db.ts'

const redis = new Redis(config.redisUrl)

const tokenKey = (token: string) => `fh:gwtoken:${token}`

export interface TokenRecord {
  userId: number
  role: Role
}

export async function storeToken(token: string, record: TokenRecord, ttlMs: number): Promise<void> {
  await redis.set(tokenKey(token), JSON.stringify(record), 'PX', ttlMs)
}

// Sliding expiration (2026-09-09, real gap found: a fixed 1-hour TTL from
// login logs an actively-working user out mid-use, no refresh-token
// mechanism exists or is planned — a full 2-token split would mainly buy
// short-lived-access-token security, not asked for; sliding renewal keeps
// the exact property this token design was chosen for, Phase 7's "admin can
// revoke instantly," while fixing the actual complaint). `GETEX` (confirmed
// supported by the installed ioredis) gets the value AND resets the TTL in
// one round trip — every successful resolution (every REST call, every WS
// connect/reconnect) pushes expiry back out to a fresh `ttlMs` from now.
export async function resolveToken(token: string, ttlMs: number): Promise<TokenRecord | undefined> {
  const raw = await redis.getex(tokenKey(token), 'PX', ttlMs)
  return raw ? (JSON.parse(raw) as TokenRecord) : undefined
}

// Renews TTL only, no value fetch (caller already knows the token's valid
// from an earlier `resolveToken`) — used for a WS connection's ONGOING
// activity, the one case `resolveToken`'s renew-on-connect can't reach: a
// single session left open and actively chatted in for over an hour with no
// other REST call in between. See proxy.ts/index.ts's `onEveryClientMessage`.
export async function renewToken(token: string, ttlMs: number): Promise<void> {
  await redis.pexpire(tokenKey(token), ttlMs)
}

export async function revokeToken(token: string): Promise<void> {
  await redis.del(tokenKey(token))
}

// ---- Security fix 2026-09-09: rate-limit /auth/login, /auth/register ----

const rateLimitKey = (bucket: string, key: string) => `fh:ratelimit:${bucket}:${key}`

/**
 * Fixed-window counter — `INCR` (creates at 0->1 if absent), `PEXPIRE` only
 * on the window's first hit so the window doesn't keep sliding forward on
 * every request (that would be sliding expiration again, not a rate limit).
 * Returns `true` when the caller is still within `max` for this window.
 */
export async function checkRateLimit(bucket: string, key: string, max: number, windowMs: number): Promise<boolean> {
  const redisKey = rateLimitKey(bucket, key)
  const count = await redis.incr(redisKey)
  if (count === 1) await redis.pexpire(redisKey, windowMs)
  return count <= max
}

// ---- Phase 12 item 2 ----

export type LiveSessionStatus = 'running' | 'hibernated' | 'archived'

interface SessionRecordShape {
  status: LiveSessionStatus
}

// Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
// finding #2): `GET /sessions/mine` used to call a single-item version of
// this once per row (N round trips even though `Promise.all`-parallelized).
// One `MGET` instead — same "best-effort" semantics as before: a Redis
// miss (session never spawned yet, or evicted) reads as `undefined`, the
// caller treats that as "not currently running", never as an error.
export async function getLiveSessionStatuses(sessionIds: string[]): Promise<Map<string, LiveSessionStatus | undefined>> {
  const result = new Map<string, LiveSessionStatus | undefined>()
  if (sessionIds.length === 0) return result
  const raws = await redis.mget(sessionIds.map((id) => `fh:session:${id}`))
  sessionIds.forEach((id, index) => {
    const raw = raws[index]
    if (!raw) {
      result.set(id, undefined)
      return
    }
    try {
      result.set(id, (JSON.parse(raw) as SessionRecordShape).status)
    } catch {
      result.set(id, undefined)
    }
  })
  return result
}
