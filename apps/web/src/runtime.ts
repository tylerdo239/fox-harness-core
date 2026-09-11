// Follow-up (2026-09-08): replaces the old `window.__FOX_HARNESS__` global
// (needed only because separate manifest-loaded bundles couldn't share a
// module graph — docs/code-rules.md's Phase 4/9 entries). Now that every
// former "UI plugin" is just a component in this ONE app, the same shape
// travels as a normal React Context instead of a global — same capabilities
// (frame pub/sub, send, session switching, gateway URL/auth helpers), just
// passed down properly instead of reached for through `window`.

import { createContext, useContext } from 'react'

import type { ClientToServer, ServerToClient } from './wire.ts'

export interface Runtime {
  sessionId: string
  // Real gap fixed 2026-09-08: the FE never captured who's logged in
  // anywhere — services/gateway's `/auth/login` now returns it, App.tsx
  // persists it to localStorage (same lifetime as the token, shared
  // across tabs — 2026-09-10, was sessionStorage) alongside.
  userEmail: string
  apiUrl: (path: string) => string
  authHeaders: () => Record<string, string>
  // Real gap fixed 2026-09-09: every call site used to build its own raw
  // `fetch(apiUrl(path), {headers: authHeaders()})` and silently swallow a
  // 401 (`if (!res.ok) return`-style, no user-visible feedback, no way back
  // to login). This wraps that same call but also triggers the shared
  // "kicked back to login" flow (App.tsx's `handleAuthExpired()`) on a 401
  // — callers keep their own `res.ok`/status handling completely unchanged,
  // they just also recover gracefully instead of failing silently forever.
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>
  onFrame: (listener: (frame: ServerToClient) => void) => () => void
  send: (frame: ClientToServer) => void
  switchSession: (sessionId: string) => void
  newSession: () => void
}

export const RuntimeContext = createContext<Runtime | null>(null)

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error('fox-harness-web: useRuntime() called outside <RuntimeContext.Provider>')
  return runtime
}
