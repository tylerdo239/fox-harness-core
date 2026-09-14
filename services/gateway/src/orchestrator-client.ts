// Thin HTTP client for services/orchestrator's control API (roadmap Phase 3).
// Replaces Phase 2's fixed TRANSPORT_HOST/TRANSPORT_PORT — every connection
// now asks the orchestrator where its worker actually is, since that can be
// a different container each time (spawn, rehydrate after hibernate/kill,
// or a warm-pool claim). Uses the shared @fox-harness/contracts response
// shape (docs/code-rules.md §1: services/* only imports contracts).

import type {
  EnsureSessionRequest,
  EnsureSessionResponse,
  SkillsSyncRequest,
  SkillsSyncResponse,
  TouchSessionReason,
} from '@fox-harness/contracts'

import { config } from './config.ts'

// Security fix 2026-09-09: services/orchestrator now rejects every request
// without this exact header (docs/security-performance-review-2026-09-09.md
// finding #1 — it previously had zero auth of its own). Not per-user auth,
// just proves the caller is really this service.
const internalAuthHeaders = { 'x-fox-harness-internal-secret': config.internalSecret }

// Performance fix 2026-09-09 (finding #3): none of these calls had a
// timeout before — orchestrator hanging meant every one of these hung
// right along with it, forever (the WS upgrade handler included, for
// `ensureSession`).
function requestTimeout(): AbortSignal {
  return AbortSignal.timeout(config.orchestratorRequestTimeoutMs)
}

// Phase 6 checklist item 1: carries the real HTTP status through so callers
// can tell a quota rejection (orchestrator's 429 — an expected, cheap-to-show
// outcome under load) apart from a genuine orchestrator failure (502-worthy)
// instead of collapsing both into the same generic error.
export class OrchestratorHttpError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function ensureSession(orchestratorUrl: string, sessionId: string, model?: string, flow?: string): Promise<EnsureSessionResponse> {
  const body: EnsureSessionRequest = { model, flow }
  const res = await fetch(`${orchestratorUrl}/sessions/${sessionId}/ensure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...internalAuthHeaders },
    body: JSON.stringify(body),
    signal: requestTimeout(),
  })
  if (!res.ok) throw new OrchestratorHttpError(`orchestrator ensure(${sessionId}) failed: HTTP ${res.status}`, res.status)
  return (await res.json()) as EnsureSessionResponse
}

// Phase 12 item 4: the operator-configured model allow-list, proxied
// byte-blind (same relay philosophy as everything this gateway forwards).
export async function fetchModels(orchestratorUrl: string): Promise<string[]> {
  const res = await fetch(`${orchestratorUrl}/models`, { headers: internalAuthHeaders, signal: requestTimeout() })
  if (!res.ok) throw new OrchestratorHttpError(`orchestrator models() failed: HTTP ${res.status}`, res.status)
  const body = (await res.json()) as { models: string[] }
  return body.models
}

// Phase 6 checklist item 4: real delete-on-request, proxied straight through
// to the orchestrator's own purge route (services/orchestrator/src/index.ts)
// — same byte-blind-relay spirit as everything else this gateway proxies,
// gateway itself does no deletion logic of its own.
export async function purgeSession(orchestratorUrl: string, sessionId: string): Promise<void> {
  const res = await fetch(`${orchestratorUrl}/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: internalAuthHeaders,
    signal: requestTimeout(),
  })
  if (!res.ok && res.status !== 404) {
    throw new OrchestratorHttpError(`orchestrator purge(${sessionId}) failed: HTTP ${res.status}`, res.status)
  }
}

// Per-user skills: orchestrator writes `skills` into every listed session's
// $DSH_HOME/skills and returns the ids it actually wrote.
export async function syncSkills(orchestratorUrl: string, body: SkillsSyncRequest): Promise<string[]> {
  const res = await fetch(`${orchestratorUrl}/skills-sync`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...internalAuthHeaders },
    body: JSON.stringify(body),
    signal: requestTimeout(),
  })
  if (!res.ok) throw new OrchestratorHttpError(`orchestrator skills-sync failed: HTTP ${res.status}`, res.status)
  return ((await res.json()) as SkillsSyncResponse).synced
}

// Fire-and-forget from the caller's perspective — a missed touch just means
// the idle sweep's clock runs a little differently, never a correctness bug
// (services/orchestrator/src/sweep.ts's own documented scope cuts already
// cover the sharper edges here).
export function touchSession(orchestratorUrl: string, sessionId: string, reason: TouchSessionReason): void {
  fetch(`${orchestratorUrl}/sessions/${sessionId}/touch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...internalAuthHeaders },
    body: JSON.stringify({ reason }),
    signal: requestTimeout(),
  }).catch((error: unknown) => {
    console.error(`[gateway] touch(${sessionId}, ${reason}) failed:`, error)
  })
}
