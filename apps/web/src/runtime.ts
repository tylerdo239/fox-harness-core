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
  // The session's socket is open — false once it drops (no auto-reconnect).
  connected: boolean
  onFrame: (listener: (frame: ServerToClient) => void) => () => void
  send: (frame: ClientToServer) => void
  // `projectId`: the chat belongs to that data-analysis project (its URL lives under /data).
  switchSession: (sessionId: string, projectId?: string) => void
  newSession: () => void
  // 2026-09-15: shared "current session's title" state so a rename typed in
  // EITHER `SessionTitleBar.tsx` (top of the chat column) or
  // `HistoryChat.tsx` (sidebar) shows up in the other without either owning
  // the other's internal state. `sessionTitle` is the value to DISPLAY;
  // `sessionsVersion` is a plain invalidation counter — bump it after a
  // successful rename and `HistoryChat.tsx`'s existing `refresh()` effect
  // (already re-fetches on session switch) also re-fetches on a bump,
  // without exposing that effect/its `rows` state through this context.
  sessionTitle: string | undefined
  setSessionTitle: (title: string | undefined) => void
  sessionsVersion: number
  bumpSessionsVersion: () => void
}

export const RuntimeContext = createContext<Runtime | null>(null)

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error('fox-harness-web: useRuntime() called outside <RuntimeContext.Provider>')
  return runtime
}
