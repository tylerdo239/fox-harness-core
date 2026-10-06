// Real login-token store (`fh:gwtoken:*`) and rate-limit counters — Redis-backed specifically so an admin can
// revoke a token instantly (docs/agent-core-architecture-roadmap.md's Phase 7 decision — chosen over a
// stateless JWT for exactly this reason). That is ALL Redis is used for now: session placement no longer
// needs it (see runtime/supervisor.ts).

import { createHash } from 'node:crypto'

import { Redis } from 'ioredis'

import { config } from './config.ts'
import type { Role } from './db.ts'

const redis = new Redis(config.redisUrl)

// Only a SHA-256 of a token is ever written to Redis (the key and the per-user index): whoever reads Redis — a
// dump, a backup, a misconfigured network — learns no token they could log in with. Tokens are 256-bit random, so
// an unsalted fast hash is enough.
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const tokenKey = (token: string) => `fh:gwtoken:${tokenHash(token)}`

export interface TokenRecord {
  userId: number
  role: Role
}

const userTokensKey = (userId: number) => `fh:gwuser:${userId}`

export async function storeToken(token: string, record: TokenRecord, ttlMs: number): Promise<void> {
  await redis.set(tokenKey(token), JSON.stringify(record), 'PX', ttlMs)
  // Index the token under its user so a role change / password reset can revoke every live login of that user
  // (a token carries the role it was issued with). Entries of expired tokens are harmless: revoking them is a no-op.
  await redis.sadd(userTokensKey(record.userId), tokenHash(token))
}

/** Revoke every token issued to `userId` (role changed, password reset): their next request is a 401. */
export async function revokeUserTokens(userId: number): Promise<number> {
  const hashes = await redis.smembers(userTokensKey(userId))
  if (hashes.length > 0) await redis.del(...hashes.map((hash) => `fh:gwtoken:${hash}`))
  await redis.del(userTokensKey(userId))
  return hashes.length
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

// ---- WebSocket tickets (2026-10-06) ----
// A browser cannot set a header on a WebSocket upgrade, so the login token used to travel in the URL
// (`?token=`), where every proxy access log in between records it. The FE now trades its token for a ticket
// (POST /auth/ws-ticket) and opens the socket with that instead: random, single use (GETDEL), 30 s, and stored as
// the hash of the TOKEN it stands for — no raw token or ticket in Redis, and a revoked token voids its tickets.
const ticketKey = (ticket: string) => `fh:wsticket:${tokenHash(ticket)}`

export async function storeWsTicket(ticket: string, token: string, ttlMs: number): Promise<void> {
  await redis.set(ticketKey(ticket), tokenHash(token), 'PX', ttlMs)
}

/** The ticket's login (resolved and renewed like a token), consuming the ticket; undefined if unknown, used or expired. */
export async function takeWsTicket(ticket: string, ttlMs: number): Promise<{ record: TokenRecord; tokenHash: string } | undefined> {
  const hash = await redis.getdel(ticketKey(ticket))
  if (!hash) return undefined
  const raw = await redis.getex(`fh:gwtoken:${hash}`, 'PX', ttlMs)
  return raw ? { record: JSON.parse(raw) as TokenRecord, tokenHash: hash } : undefined
}

/** renewToken for a socket opened with a ticket: only the token's hash is known there. */
export async function renewTokenHash(hash: string, ttlMs: number): Promise<void> {
  await redis.pexpire(`fh:gwtoken:${hash}`, ttlMs)
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
