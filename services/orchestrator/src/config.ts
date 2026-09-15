// Plain process.env, loaded from .env the same way services/gateway does
// (docs/code-rules.md §1 boundary — this file is the only place orchestrator
// reads the environment, everything else takes values as arguments).

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

// Security fix 2026-09-09 — mirrored from services/gateway/src/config.ts's
// own `requireEnv` (same "mirrored, not imported" convention this repo
// already uses for small cross-boundary utilities, docs/code-rules.md §1
// boundary: services/* never import each other). Deliberate exception to
// every other setting in this file's "unconfigured = permissive default"
// convention — see that gateway comment for the full reasoning
// (docs/security-performance-review-2026-09-09.md finding #1: this
// service otherwise has zero auth of its own on any route).
function requireEnv(name: string): string {
  const raw = process.env[name]
  if (!raw) {
    throw new Error(`fox-harness-orchestrator: ${name} is required (this service has no auth of its own otherwise) — set it in the shared .env`)
  }
  return raw
}

// docs/data-analysis-flow-plan.md: which agent loop/profile a session's
// container boots with. A static registry, not env-driven like
// `allowedModels` below — which flows exist is a product/deploy decision,
// not something an operator tunes. `default`'s `profileName` MUST stay
// `'fox-harness'` — sessions created before this registry existed already
// have `profiles/fox-harness/` materialized on disk (materialize.ts never
// re-materializes an existing session's directory), and rehydrating one
// must find that same directory name.
// `cwd` (docs/rlm-transfer-plan.md giai đoạn 2): the container path a session
// of that flow works in. Must be under /data (the bind mount) so files survive
// hibernation; `undefined` keeps the image's WORKDIR (/repo).
const flows = {
  default: { profileName: 'fox-harness', templatePackage: '@fox-harness/profile-template', cwd: undefined },
  'data-analysis': { profileName: 'fox-harness-data-analysis', templatePackage: '@fox-harness/profile-template-data-analysis', cwd: '/data/workspace' },
} as const

export const config = {
  port: envIntOr('ORCHESTRATOR_PORT', 4100),
  // Security fix 2026-09-09: checked against the `x-fox-harness-internal-secret`
  // header on every request, before any route matching (index.ts) — proves
  // the caller really is services/gateway, not per-user auth (this service
  // still never learns who a user is).
  internalSecret: requireEnv('ORCHESTRATOR_INTERNAL_SECRET'),
  redisUrl: envOr('REDIS_URL', 'redis://127.0.0.1:6379'),
  workerImage: envOr('WORKER_IMAGE', 'fox-harness-worker:dev'),
  // Absolute host path — every session gets a subdirectory here, bind-mounted
  // into its container as $DSH_HOME. Must be absolute: Docker bind mounts
  // reject relative host paths.
  dataDir: envOr('ORCHESTRATOR_DATA_DIR', `${process.cwd()}/data/dsh-home`),
  // docs/rlm-transfer-plan.md 9.1: one shared working directory per project,
  // bind-mounted over a project chat's own. Absolute, same as dataDir.
  projectsDir: envOr('ORCHESTRATOR_PROJECTS_DIR', `${process.cwd()}/data/projects`),
  // Fixed container-internal port — packages/transport's own default
  // (packages/transport/README.md). Only the HOST side varies per container
  // (random, so many can run concurrently); no reason to make this configurable.
  workerTransportPort: 4001,
  // Security fix 2026-09-09: `docs/security-performance-review-2026-09-09.md`
  // finding #3 — worker containers had NO resource limits at all (the model
  // "1 container per user because code runs arbitrary" isolated process,
  // never resource — 1 session could starve every other container's CPU/
  // RAM/PIDs on the same host). Wired into docker.ts's `createContainer()`
  // HostConfig (`Memory` in bytes, `NanoCpus` = cores × 1e9, `PidsLimit`).
  // Permissive numeric defaults here, not a new security control the way
  // `internalSecret` above is — the usual "unconfigured = sane default"
  // convention applies.
  workerMemoryMb: envIntOr('WORKER_MEMORY_MB', 2048),
  workerCpuLimit: envIntOr('WORKER_CPU_LIMIT', 2),
  workerPidsLimit: envIntOr('WORKER_PIDS_LIMIT', 512),
  warmPoolSize: envIntOr('WARM_POOL_SIZE', 2),
  // Largest file accepted into a data-analysis working directory (same 70 MiB
  // cap agent-core's api-rest used for uploads).
  maxUploadBytes: envIntOr('MAX_UPLOAD_BYTES', 70 * 1024 * 1024),
  idleTtlMs: envIntOr('IDLE_TTL_MS', 10 * 60 * 1000),
  sweepIntervalMs: envIntOr('SWEEP_INTERVAL_MS', 60 * 1000),
  spawnLockTtlMs: 10 * 1000,
  // Phase 6 checklist item 1: quota. "theo user" in the roadmap's own words,
  // but this project has no real user identity yet (Phase 5's own declared
  // scope cut — only sessionId). Both caps below are therefore GLOBAL
  // (concurrent sessions) or PER-SESSION (max age), the two things this
  // system can actually count without inventing a user model it doesn't
  // have. 0 = unlimited (the default — do not silently cap a dev setup that
  // never configured this).
  maxConcurrentSessions: envIntOr('MAX_CONCURRENT_SESSIONS', 0),
  maxSessionAgeMs: envIntOr('MAX_SESSION_AGE_MS', 0),
  // Phase 6 checklist item 4: log retention. A session hibernated for
  // longer than this gets its dshHomeDir compressed into `archiveDir` and
  // removed from live disk (services/orchestrator/src/archive.ts) — real
  // compress+move, not a policy that only exists on paper. 0 = never
  // archive (the default).
  archiveAfterHibernatedMs: envIntOr('ARCHIVE_AFTER_HIBERNATED_MS', 0),
  archiveDir: envOr('ORCHESTRATOR_ARCHIVE_DIR', `${process.cwd()}/data/_archive`),
  // Forwarded verbatim into every spawned container's environment — the
  // container has no .env of its own (see infra/docker/worker/Dockerfile);
  // this is how the real model credentials reach it, and (Phase 6) how
  // `packages/core`'s per-session token-budget quota (quota.ts) reaches it
  // too — that component reads SESSION_TOKEN_BUDGET via
  // `launchEnvironmentOf(ctx)` same as everything else here, and sees
  // nothing unless it's forwarded through this list. Documented in
  // .env.example. `LLM_IDLE_TIMEOUT_MS` added 2026-09-09 (performance fix
  // #4) — `packages/llm/openai-compat`'s adapter reads it the same way.
  // `SERPER_API_KEY` added 2026-09-14 for `packages/tool/serper-web-search`.
  // `OPENAI_CONTEXT_WINDOW` (2026-09-14): the model's context size, read by
  // the openai-compat adapter so compaction-basic can compact before overflow.
  // `OPENAI_EXTRA_BODY` (2026-09-14): extra request fields for that adapter.
  workerEnvPassthrough: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL_ID', 'OPENAI_CONTEXT_WINDOW', 'OPENAI_EXTRA_BODY', 'SESSION_TOKEN_BUDGET', 'LLM_IDLE_TIMEOUT_MS', 'SERPER_API_KEY'] as const,
  // Phase 12 item 4: model chosen PER SESSION at creation time (not
  // mid-session — see ensure.ts). A comma-separated allow-list; falls back
  // to a single-item list built from OPENAI_MODEL_ID (the pre-Phase-12
  // single-value behavior) so an operator who hasn't configured this yet
  // still gets exactly one valid, working choice instead of an empty list.
  allowedModels: (() => {
    const raw = envOr('OPENAI_ALLOWED_MODELS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return raw.length > 0 ? raw : [envOr('OPENAI_MODEL_ID', 'default')]
  })(),
  flows,
  allowedFlows: Object.keys(flows),
}
