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
