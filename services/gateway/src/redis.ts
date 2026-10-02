// Real login-token store (`fh:gwtoken:*`) and rate-limit counters — Redis-backed specifically so an admin can
// revoke a token instantly (docs/agent-core-architecture-roadmap.md's Phase 7 decision — chosen over a
// stateless JWT for exactly this reason). That is ALL Redis is used for now: session placement no longer
// needs it (see runtime/supervisor.ts).

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
