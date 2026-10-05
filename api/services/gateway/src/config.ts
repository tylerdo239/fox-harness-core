// Plain process.env, loaded from .env (docs/code-rules.md §1 boundary — this
// file is the only place gateway reads the environment).

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

try {
  process.loadEnvFile()
} catch {
  // no .env next to cwd — fine, real deployments set these via the process
  // environment directly (containers, systemd units, ...)
}

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

// A setting with no safe default: fail loudly at boot instead of at the first request.
function requireEnv(name: string): string {
  const raw = process.env[name]
  if (!raw) throw new Error(`fox-harness-gateway: ${name} is required — set it in the environment (.env)`)
  return raw
}

function envIntOr(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const confineRunner = join(repoRoot, 'docker/fox-confine.sh')
const isProd = process.env.NODE_ENV === 'production'

// Which agent flows exist (each is an agent preset in packages/profile-template/presets). `workspace`
// = the flow works on the user's files, so its working directory gets the files API.
const flows = {
  default: { workspace: false },
  'data-analysis': { workspace: true },
  'data-studio': { workspace: false },
} as const

export const config = {
  port: envIntOr('GATEWAY_PORT', 4000),
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
  // Login tokens (`fh:gwtoken:*`) and auth rate-limit counters live here.
  redisUrl: envOr('REDIS_URL', 'redis://127.0.0.1:6379'),
  tokenTtlMs: envIntOr('TOKEN_TTL_MS', 60 * 60 * 1000),
  // Security fix 2026-09-09: docs/security-performance-review-2026-09-09.md
  // finding #5 — no rate-limit existed on /auth/login or /auth/register at
  // all. Redis-backed fixed window (redis.ts's `checkRateLimit`), keyed per
  // route so one endpoint being hammered doesn't lock out the other.
  authRateLimitMax: envIntOr('AUTH_RATE_LIMIT_MAX', 10),
  authRateLimitWindowMs: envIntOr('AUTH_RATE_LIMIT_WINDOW_MS', 60 * 1000),
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
  // docs/data-studio-mongodb-plan.md: Data Studio's semantic layer + chat history live in MongoDB,
  // shared with every worker container (Python) and with bot-data-studio-api. `MongoDBWrite` is the
  // name Vault injects on FPT infrastructure (same alias the Python settings accept); MONGODB_URL
  // is the plain-env form for local dev. A database named in the URL path wins over
  // `mongodbDatabaseName` — same rule on both sides (src/database/mongodb.py).
  mongodbUrl: process.env.MONGODB_URL ?? process.env.MongoDBWrite ?? 'mongodb://127.0.0.1:27017',
  mongodbDatabaseName: envOr('MONGODB_DATABASE_NAME', 'bot_data_studio'),
  // ---- The agent runtime (docs/single-backend-architecture-plan.md) ----
  // This process now owns what services/orchestrator used to: it starts the `dsh` runtime(s) and routes
  // each session to one. Everything below is that.
  repoRoot,
  // Everything on disk lives under here: the dsh home (logs, profile), `users/<userId>/<sessionId>/`
  // workspaces, `projects/<projectId>/`. Must be OUTSIDE any git checkout: skill discovery takes the
  // nearest `.git` ancestor as a project root, which would make every workspace share one (checked at boot).
  dataDir: envOr('GATEWAY_DATA_DIR', join(homedir(), '.fox-harness', 'data')),
  // `dsh` is started as a program, never imported (docs/code-rules.md §1).
  dshBin: envOr('FOX_DSH_BIN', join(repoRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')),
  // K runtimes share one dsh home; a session goes to hash(sessionId) % K. One runtime tops out around a
  // hundred concurrently *streaming* sessions (docs §13.7), so K is how a node uses more than one core.
  runtimeCount: Math.max(1, envIntOr('FOX_RUNTIME_COUNT', 1)),
  runtimeBasePort: envIntOr('FOX_RUNTIME_BASE_PORT', 4201),
  runtimeReadyTimeoutMs: envIntOr('FOX_RUNTIME_READY_TIMEOUT_MS', 60_000),
  // Strict bubblewrap runner for bash/python (docker/fox-confine.sh). Required in production:
  // without it model-run code can read every other user's files.
  confineRunner: existsSync(confineRunner) ? confineRunner : undefined,
  requireSandbox: envOr('FOX_REQUIRE_SANDBOX', isProd ? '1' : '0') === '1',
  maxUploadBytes: envIntOr('MAX_UPLOAD_BYTES', 70 * 1024 * 1024),
  // 0 = unlimited. Counted over sessions that have an open browser connection.
  maxConcurrentSessions: envIntOr('MAX_CONCURRENT_SESSIONS', 0),
  maxSessionsPerUser: envIntOr('MAX_SESSIONS_PER_USER', 0),
  // Chosen per session at creation (stored in discovery_sessions.model); falls back to OPENAI_MODEL_ID.
  allowedModels: (() => {
    const raw = envOr('OPENAI_ALLOWED_MODELS', '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    return raw.length > 0 ? raw : [envOr('OPENAI_MODEL_ID', 'default')]
  })(),
  flows,
  allowedFlows: Object.keys(flows),
  // The ONLY variables the runtime process inherits from this one. The database URL, S3 and Redis
  // credentials, and anything else of the gateway's stay out of a process that runs model-written code.
  runtimeEnvPassthrough: [
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL_ID', 'OPENAI_CONTEXT_WINDOW', 'OPENAI_EXTRA_BODY',
    'SESSION_TOKEN_BUDGET', 'LLM_IDLE_TIMEOUT_MS', 'SERPER_API_KEY',
    'EMBEDDING_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL_ID',
    'DREMIO_URL', 'DREMIO_USERNAME', 'DREMIO_PASSWORD',
    'MEILISEARCH_URL', 'MEILISEARCH_MASTER_KEY', 'MEILISEARCH_SEMANTIC_RATIO',
    'DATA_STUDIO_V3_DEBUG', 'MONGODB_URL', 'MongoDBWrite', 'MONGODB_DATABASE_NAME',
    'FOX_PYTHON', 'FOX_PYTHON_DATA_STUDIO', 'DATA_STUDIO_AGENT_DIR',
    'FOX_DS_WORKERS', 'FOX_DS_QUEUE_TIMEOUT_MS', 'FOX_DS_IDLE_MS',
    'FOX_PY_IDLE_MS', 'FOX_PY_FORGET_MS', 'FOX_PY_MAX_KERNELS', 'FOX_PY_CELL_TIMEOUT_MS',
    'FOX_IDLE_DISPOSE_MS', 'FOX_IDLE_SWEEP_MS',
  ] as const,
}
