// Plain process.env, loaded from .env the same way services/orchestrator
// does (docs/code-rules.md §1 boundary — this file is the only place
// gateway reads the environment). Phase 7 grew this from 4 inline
// `process.env` reads directly in index.ts into a real config module,
// matching the pattern services/orchestrator already uses — justified now
// that gateway owns real state (MariaDB users/ownership, Redis tokens), not
// just 2 proxy target URLs.

try {
  process.loadEnvFile()
} catch {
  // no .env next to cwd — fine, real deployments set these via the process
  // environment directly (containers, systemd units, ...)
}

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

function envIntOr(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

// Security fix 2026-09-09: deliberate exception to every other setting in
// this file's "unconfigured = permissive default" convention — a shared
// secret that silently no-ops when unset would defeat the exact fix it's
// for (services/orchestrator's routes otherwise have zero auth of their
// own, docs/security-performance-review-2026-09-09.md finding #1). Fails
// loud at boot instead. Low real friction: both gateway and orchestrator
// already load the SAME root `.env` (each via its own `process.loadEnvFile()`
// from cwd), so one added line covers both processes.
function requireEnv(name: string): string {
  const raw = process.env[name]
  if (!raw) {
    throw new Error(
      `fox-harness-gateway: ${name} is required (services/orchestrator has no auth of its own otherwise) — set it in the shared .env`,
    )
  }
  return raw
}

export const config = {
  port: envIntOr('GATEWAY_PORT', 4000),
  orchestratorUrl: envOr('ORCHESTRATOR_URL', 'http://127.0.0.1:4100').replace(/\/$/, ''),
  // Port 3307, not 3306 — this dev machine may already run a local
  // MariaDB/MySQL on 3306 (same dodge as the old Postgres 5433-not-5432
  // default). Phase 7 added `users`/`sessions`; `plugin_catalog`/
  // `session_enabled_plugins` (Phase 5) lived here too until Phase 16
  // removed them for real (docs/agent-core-architecture-roadmap.md's Phase
  // 16 — the whole per-user/session plugin catalog was solving a need that
  // didn't actually exist). Migrated off Postgres 2026-09-09 — prod's DB
  // server is MariaDB (docs/code-rules.md's MariaDB-migration section) —
  // `mariadb://` is a real, required scheme (services/gateway/src/db.ts's
  // comment on `createPool`), not an arbitrary label.
  databaseUrl: envOr('DATABASE_URL', 'mariadb://fox_harness:fox_harness_dev@127.0.0.1:3307/fox_harness'),
  // Same Redis this repo has run since Phase 3 (services/orchestrator's
  // affinity store) — Phase 7 tokens live under a distinct `fh:gwtoken:`
  // key prefix, no collision with orchestrator's `fh:session:*`/`fh:warmpool`/
  // `fh:lock:*` keys.
  redisUrl: envOr('REDIS_URL', 'redis://127.0.0.1:6379'),
  tokenTtlMs: envIntOr('TOKEN_TTL_MS', 60 * 60 * 1000),
  // Security fix 2026-09-09: sent as `x-fox-harness-internal-secret` on
  // every call to services/orchestrator (orchestrator-client.ts) — see
  // `requireEnv`'s own comment above for why this one setting fails loud
  // instead of falling back.
  internalSecret: requireEnv('ORCHESTRATOR_INTERNAL_SECRET'),
  // Security fix 2026-09-09: docs/security-performance-review-2026-09-09.md
  // finding #5 — no rate-limit existed on /auth/login or /auth/register at
  // all. Redis-backed fixed window (redis.ts's `checkRateLimit`), keyed per
  // route so one endpoint being hammered doesn't lock out the other.
  authRateLimitMax: envIntOr('AUTH_RATE_LIMIT_MAX', 10),
  authRateLimitWindowMs: envIntOr('AUTH_RATE_LIMIT_WINDOW_MS', 60 * 1000),
  // Performance fix 2026-09-09 (docs/security-performance-review-2026-09-09.md
  // finding #3): every orchestrator-client.ts call had no timeout at all —
  // orchestrator hanging meant the WS upgrade handler hung right along with
  // it, forever.
  orchestratorRequestTimeoutMs: envIntOr('ORCHESTRATOR_REQUEST_TIMEOUT_MS', 10 * 1000),
  // Performance fix 2026-09-09 (finding #6): `mariadb.createPool()` had no
  // explicit `connectionLimit` — see db.ts's own comment for how this was
  // verified to actually need the object-config form, not a query-string
  // param on the connection URL.
  dbConnectionLimit: envIntOr('DB_CONNECTION_LIMIT', 10),
  // 2026-09-14: `custom_skills.content` moved off MariaDB onto object
  // storage (services/gateway/src/object-storage.ts) — the DB row only
  // keeps a `content_key` reference now. `requireEnv` for bucket/
  // credentials, same as `internalSecret` above: unconfigured means every
  // skill create/update/list call fails at runtime anyway, better to fail
  // loud at boot with a clear message. `s3Endpoint` stays optional — unset
  // means the real AWS S3 endpoint (SDK default); set it to point at a
  // local MinIO (or R2/Spaces/other S3-compatible service) instead.
  s3Endpoint: process.env.S3_ENDPOINT,
  s3Region: envOr('S3_REGION', 'us-east-1'),
  s3Bucket: requireEnv('S3_BUCKET'),
  s3AccessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
  s3SecretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
  // MinIO (and most non-AWS S3-compatible services) need path-style
  // addressing (`http://host/bucket/key`) — they don't support the
  // virtual-hosted-style (`http://bucket.host/key`) AWS S3 defaults to.
  s3ForcePathStyle: envOr('S3_FORCE_PATH_STYLE', 'false') === 'true',
}
