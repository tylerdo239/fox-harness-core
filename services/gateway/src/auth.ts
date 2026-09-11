// Real authentication (Phase 7) — replaces the Phase 2-6 single shared-
// operator-secret exchange entirely (docs/agent-core-architecture-roadmap.md's
// Phase 7 section: "Thay POST /auth/token ... bằng POST /auth/login thật").
// `role='admin'` is never reachable from `register()` — the only path to an
// admin account is `scripts/create-admin.mjs`, run out-of-band against the
// database directly, never over HTTP.

import { randomBytes } from 'node:crypto'

import { config } from './config.ts'
import { createUser, getUserByEmail, type Role } from './db.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { resolveToken, revokeToken, storeToken, type TokenRecord } from './redis.ts'

export type AuthedIdentity = TokenRecord

// Security fix 2026-09-09: a real timing side-channel — `login()` used to
// return immediately (skipping `verifyPassword`/scrypt entirely) when the
// email didn't exist, but ran the full scrypt computation when it did but
// the password was wrong. Response time alone let a caller enumerate which
// emails have real accounts. Fixed by always running `verifyPassword`
// against SOME hash — the real one when the user exists, this fixed dummy
// one when they don't — so both paths take the same time regardless.
// Computed once at module load (not per-request) since it's a constant.
const DUMMY_PASSWORD_HASH = await hashPassword('fox-harness-timing-safety-dummy')

export async function register(email: string, password: string): Promise<{ id: number; email: string; role: Role }> {
  const existing = await getUserByEmail(email)
  if (existing) throw new Error('email already registered')
  const passwordHash = await hashPassword(password)
  try {
    const user = await createUser(email, passwordHash, 'user')
    return { id: user.id, email: user.email, role: user.role }
  } catch (error) {
    // Bug fix 2026-09-09 (docs/security-performance-review-2026-09-09.md's
    // Bug #2): a real TOCTOU race — 2 concurrent requests for the SAME
    // email both pass the `getUserByEmail` check above (neither exists
    // yet), so both reach `createUser`; the DB's own unique constraint on
    // `email` catches the second one at INSERT time instead. Before this
    // fix that surfaced as a raw MariaDB error falling through to
    // index.ts's generic 500 ("registration failed") — safe (no leak,
    // §53 already fixed that), but a misleading status for what's really
    // the exact same "email taken" case as the pre-check above. `ER_DUP_ENTRY`
    // confirmed for real against the live MariaDB (a genuine duplicate
    // insert throws with `error.code === 'ER_DUP_ENTRY'`, errno 1062,
    // sqlState 23000) — re-throw the same clean Error so this races into
    // the identical, already-existing 409 branch the pre-check case uses.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') {
      throw new Error('email already registered')
    }
    throw error
  }
}

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; userId: number; email: string; role: Role } | undefined> {
  const user = await getUserByEmail(email)
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)
  if (!user || !valid) return undefined
  const token = randomBytes(32).toString('hex')
  await storeToken(token, { userId: user.id, role: user.role }, config.tokenTtlMs)
  // Real gap fixed 2026-09-08: the FE had no way to know who's actually
  // logged in — `POST /auth/login` never returned the email back, and no
  // other route exposes it either. `user.email` is already in hand here
  // (looked up to verify the password), so returning it costs nothing extra.
  return { token, userId: user.id, email: user.email, role: user.role }
}

// Sliding expiration (2026-09-09) — every resolution renews the TTL, so
// `config.tokenTtlMs` here is "how long since the LAST use," not "since
// login." See redis.ts's `resolveToken` for the real mechanism (`GETEX`).
export async function resolveIdentity(token: string): Promise<AuthedIdentity | undefined> {
  return resolveToken(token, config.tokenTtlMs)
}

export async function logout(token: string): Promise<void> {
  await revokeToken(token)
}
