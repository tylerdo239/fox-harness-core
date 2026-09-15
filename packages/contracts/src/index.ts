// Type-only contract between services/* and apps/web/*. Never import from a
// `dsh-*` bundle package here — that would let control-plane code see bundle
// internals, which docs/code-rules.md §1 forbids.

// services/gateway <-> services/orchestrator (Phase 3). Gateway generates a
// fresh sessionId for a new connection (it must know the id before routing,
// unlike Phase 2's fixed single worker — see services/gateway/README.md) and
// calls `ensure` for both new and reconnecting sessions; orchestrator returns
// where a live worker for that session is reachable, spawning/rehydrating a
// container as needed.
export interface EnsureSessionResponse {
  host: string
  port: number
}

export interface EnsureSessionRequest {
  // Phase 12: which model to spawn a BRAND-NEW session's container with
  // (validated against orchestrator's own `config.allowedModels` — gateway
  // never validates this itself, same "services/* never knows bundle/LLM
  // internals" boundary as everything else here). Ignored for an existing
  // session's reconnect/rehydrate — orchestrator reuses the value it already
  // stored on that session's Redis record (services/orchestrator/src/redis.ts's
  // `SessionRecord.model`), since Phase 12 deliberately only supports
  // choosing a model at session-creation time, not mid-session.
  model?: string
  // Which agent loop/profile to spawn a BRAND-NEW session's container with —
  // validated against orchestrator's own `config.allowedFlows`
  // (services/orchestrator/src/config.ts). Ignored for an existing session's
  // reconnect/rehydrate — orchestrator reuses the value already stored on
  // that session's Redis record (`SessionRecord.flow`), same rule as
  // `model` above: chosen once at creation, never mid-session. Undefined
  // means the default flow/loop (`@fox-harness/dsh-agent-driver`).
  flow?: string
  // docs/rlm-transfer-plan.md 9.1: the project a BRAND-NEW data-analysis
  // session belongs to — it works in the project's shared folder. Ignored on
  // reconnect/rehydrate (the Redis record keeps it), same rule as `flow`.
  projectId?: string
}

// Gateway calls this on connect/disconnect so the orchestrator's idle sweep
// has a liveness signal without knowing anything about session content
// (roadmap: orchestrator "không biết nội dung session").
export type TouchSessionReason = 'connected' | 'disconnected'

// Phase 12: GET /models (services/orchestrator, proxied byte-blind through
// services/gateway) — the operator-configured allow-list a session's model
// can be chosen from at creation time.
export interface ModelsResponse {
  models: string[]
}

// Per-user skills (docs/skill-transfer-plan.md). Gateway owns them (MariaDB
// `custom_skills`); PUT /skills-sync hands orchestrator the files to write
// into each listed session's $DSH_HOME/skills — session ids and files only,
// never whose skills they are.
export interface SkillFile {
  name: string
  description: string
  content: string
}

export interface SkillsSyncRequest {
  sessionIds: string[]
  skills: SkillFile[]
}

export interface SkillsSyncResponse {
  // Sessions actually written — unknown and archived ones are skipped (an
  // archived session gets synced again by gateway when it is reopened).
  synced: string[]
}

// Data-analysis working directory (docs/rlm-transfer-plan.md giai đoạn 4):
// GET /sessions/:id/files on orchestrator, relayed by gateway.
export interface WorkspaceFile {
  // Relative to the working directory, `/`-separated.
  path: string
  sizeBytes: number
  modified: string
}

export interface WorkspaceFilesResponse {
  files: WorkspaceFile[]
}

// POST /projects/:id/promote (docs/rlm-transfer-plan.md 9.1, "Đưa vào dự án"):
// copy one chat's output, `generated/<sessionId>/<path>`, into the project's
// shared `outputs/` folder.
export interface ProjectPromoteRequest {
  sessionId: string
  path: string
}
